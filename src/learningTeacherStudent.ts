/**
 * Teacher-Student soft transfer — blends TA weight tendencies and ranking hints.
 * Never clones playbooks, TP/SL, or risk caps. Rollback if student worsens.
 */

import fs from 'fs';
import { dataFile, ensureDataDir, atomicWriteJson } from './dataDir';
import {
  getLearningAcceleratorsConfig,
  type LearningAccelStrength,
  pushAccelDecisionRef,
} from './learningReplayBuffer';
import {
  getProfileLearningEpisodes,
  getProfileEpisodeExpectancy,
} from './profileLearningEpisodes';

export interface TeacherStudentTransfer {
  at: number;
  studentId: string;
  teacherId: string;
  strength: LearningAccelStrength;
  summary: string;
  /** Snapshot for rollback */
  beforeToolWeights: Record<string, number>;
  afterToolWeights: Record<string, number>;
  studentExpectancyBefore: number;
  closesSinceTransfer: number;
  status: 'active' | 'rolled_back' | 'failed';
}

interface TeacherStudentState {
  version: 1;
  transfers: TeacherStudentTransfer[];
  updatedAt: number;
}

const FILE = 'learning-teacher-student.json';
const MIN_TEACHER_EPISODES = 20;
const MIN_STUDENT_EPISODES = 4;
const TRANSFER_COOLDOWN_MS = 24 * 3_600_000;
const ROLLBACK_MIN_CLOSES = 6;
const PREFERRED_TEACHERS = [
  'dip_buyer',
  'trend_rider',
  'steady_compounder',
  'high_win_rate',
];

let cache: TeacherStudentState | null = null;

function path(): string {
  ensureDataDir();
  return dataFile(FILE);
}

function loadState(): TeacherStudentState {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(path(), 'utf8')) as TeacherStudentState;
    if (raw?.version === 1) {
      cache = {
        version: 1,
        transfers: Array.isArray(raw.transfers) ? raw.transfers : [],
        updatedAt: Number(raw.updatedAt) || Date.now(),
      };
      return cache;
    }
  } catch {
    /* */
  }
  cache = { version: 1, transfers: [], updatedAt: Date.now() };
  return cache;
}

function saveState(st: TeacherStudentState = loadState()): void {
  st.updatedAt = Date.now();
  cache = st;
  try {
    atomicWriteJson(path(), st);
  } catch {
    /* */
  }
}

function strengthBlend(s: LearningAccelStrength): number {
  if (s === 'high') return 0.25;
  if (s === 'medium') return 0.18;
  return 0.12;
}

function isLaggingProfile(profileId: string): boolean {
  try {
    const { getLaggingProfile } =
      require('./marlLaggingSupport') as typeof import('./marlLaggingSupport');
    const rt = getLaggingProfile(profileId);
    return rt?.status === 'lagging' || rt?.status === 'cooling';
  } catch {
    return false;
  }
}

function isEligibleTeacher(profileId: string): boolean {
  const exp = getProfileEpisodeExpectancy(profileId, { lastN: 40 });
  if (exp.n < MIN_TEACHER_EPISODES || exp.expectancyPct <= 0) return false;
  if (isLaggingProfile(profileId)) return false;
  return true;
}

function isEligibleStudent(profileId: string): boolean {
  const exp = getProfileEpisodeExpectancy(profileId, { lastN: 30 });
  if (exp.n < MIN_STUDENT_EPISODES && !isLaggingProfile(profileId)) return false;
  if (exp.n >= MIN_TEACHER_EPISODES && exp.expectancyPct > 2 && !isLaggingProfile(profileId)) {
    return false;
  }
  return isLaggingProfile(profileId) || exp.n < 15 || exp.expectancyPct < 0;
}

function recentTransferForStudent(studentId: string): TeacherStudentTransfer | null {
  const st = loadState();
  const recent = st.transfers
    .filter((t) => t.studentId === studentId && t.status === 'active')
    .sort((a, b) => b.at - a.at)[0];
  if (!recent) return null;
  if (Date.now() - recent.at < TRANSFER_COOLDOWN_MS) return recent;
  return null;
}

function pickTeacher(studentId: string): string | null {
  const candidates = PREFERRED_TEACHERS.filter(
    (id) => id !== studentId && isEligibleTeacher(id)
  );
  if (candidates.length) {
    return candidates.sort((a, b) => {
      const ea = getProfileEpisodeExpectancy(a, { lastN: 40 });
      const eb = getProfileEpisodeExpectancy(b, { lastN: 40 });
      return eb.expectancyPct - ea.expectancyPct;
    })[0];
  }
  try {
    const { TRADE_PROFILE_CATALOG } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    const all = TRADE_PROFILE_CATALOG.map((d) => d.id).filter(
      (id) => id !== studentId && isEligibleTeacher(id)
    );
    if (!all.length) return null;
    return all.sort((a, b) => {
      const ea = getProfileEpisodeExpectancy(a, { lastN: 40 });
      const eb = getProfileEpisodeExpectancy(b, { lastN: 40 });
      return eb.expectancyPct - ea.expectancyPct;
    })[0];
  } catch {
    return null;
  }
}

function clampWeight(w: number): number {
  return Math.max(0.5, Math.min(1.5, w));
}

export function maybeTeacherStudentTransfer(studentId: string): TeacherStudentTransfer | null {
  const cfg = getLearningAcceleratorsConfig();
  if (!cfg.enabled || !cfg.teacherStudentEnabled) return null;
  if (!isEligibleStudent(studentId)) return null;
  if (recentTransferForStudent(studentId)) return null;

  const teacherId = pickTeacher(studentId);
  if (!teacherId) return null;

  try {
    const store = require('./profileTaPlaybookStore') as typeof import('./profileTaPlaybookStore');
    const teacherPb = store.getProfileTaPlaybook(teacherId);
    const studentPb = store.getProfileTaPlaybook(studentId);
    if (!teacherPb || !studentPb) return null;

    const blend = strengthBlend(cfg.strength);
    const beforeToolWeights: Record<string, number> = {
      ...(studentPb.learned?.toolWeights || {}),
    };
    const afterToolWeights = { ...beforeToolWeights };

    const tWeights = teacherPb.learned?.toolWeights || {};
    for (const [tool, tw] of Object.entries(tWeights)) {
      const tv = Number(tw);
      if (!Number.isFinite(tv) || Math.abs(tv - 1) < 0.02) continue;
      const sv = Number(afterToolWeights[tool] ?? 1);
      afterToolWeights[tool] = clampWeight(sv + (tv - sv) * blend);
    }

    store.applyProfileTaLearnedWeights(
      studentId,
      { toolWeights: afterToolWeights },
      {
        historySummary: `Teacher→student from ${teacherId} (${(blend * 100).toFixed(0)}% blend)`,
        historyKind: 'nudge',
        historySource: 'auto',
      }
    );

    const expBefore = getProfileEpisodeExpectancy(studentId, { lastN: 20 }).expectancyPct;
    const transfer: TeacherStudentTransfer = {
      at: Date.now(),
      studentId,
      teacherId,
      strength: cfg.strength,
      summary: `${teacherId} → ${studentId} soft TA weight transfer (${(blend * 100).toFixed(0)}%)`,
      beforeToolWeights,
      afterToolWeights,
      studentExpectancyBefore: expBefore,
      closesSinceTransfer: 0,
      status: 'active',
    };

    const st = loadState();
    st.transfers.unshift(transfer);
    if (st.transfers.length > 40) st.transfers = st.transfers.slice(0, 40);
    saveState(st);

    pushAccelDecisionRef('teacher_student', studentId, transfer.summary);
    return transfer;
  } catch {
    return null;
  }
}

export function noteTeacherStudentClose(studentId: string): void {
  const st = loadState();
  const active = st.transfers.find(
    (t) => t.studentId === studentId && t.status === 'active'
  );
  if (!active) return;
  active.closesSinceTransfer += 1;
  if (active.closesSinceTransfer < ROLLBACK_MIN_CLOSES) {
    saveState(st);
    return;
  }
  const expNow = getProfileEpisodeExpectancy(studentId, { lastN: 20 }).expectancyPct;
  if (expNow < active.studentExpectancyBefore - 1.5) {
    try {
      const store =
        require('./profileTaPlaybookStore') as typeof import('./profileTaPlaybookStore');
      store.applyProfileTaLearnedWeights(
        studentId,
        { toolWeights: active.beforeToolWeights },
        {
          historySummary: `Rollback teacher→student transfer (expectancy ${expNow.toFixed(1)}% vs ${active.studentExpectancyBefore.toFixed(1)}%)`,
          historyKind: 'rollback',
          historySource: 'auto',
        }
      );
    } catch {
      /* */
    }
    active.status = 'rolled_back';
    pushAccelDecisionRef(
      'teacher_student_rollback',
      studentId,
      `Rolled back ${active.teacherId}→${studentId} transfer — student worsened`
    );
  }
  saveState(st);
}

export function getTeacherStudentHints(studentId: string): {
  preferTightenGiveback: boolean;
  preferTighterTrail: boolean;
  setupWorthHint: number;
  summary: string;
} | null {
  const st = loadState();
  const t = st.transfers.find(
    (x) => x.studentId === studentId && x.status === 'active'
  );
  if (!t) return null;
  const teacherEps = getProfileLearningEpisodes(t.teacherId, 30);
  const giveRate =
    teacherEps.filter((e) => (e.givebackFromPeakPct || 0) >= 12).length /
    Math.max(1, teacherEps.length);
  return {
    preferTightenGiveback: giveRate < 0.25,
    preferTighterTrail: giveRate < 0.3,
    setupWorthHint: 0.05,
    summary: t.summary,
  };
}

export function getTeacherStudentStatus(): {
  transfers: TeacherStudentTransfer[];
  activeCount: number;
} {
  const st = loadState();
  return {
    transfers: st.transfers.slice(0, 20),
    activeCount: st.transfers.filter((t) => t.status === 'active').length,
  };
}

export function formatTeacherStudentPlainLanguage(profileId: string): string {
  const st = loadState();
  const asStudent = st.transfers.find(
    (t) => t.studentId === profileId && t.status === 'active'
  );
  if (asStudent) {
    return `${asStudent.teacherId} teacher transferred stronger TA weighting tendencies to ${profileId}.`;
  }
  const asTeacher = st.transfers.find(
    (t) => t.teacherId === profileId && t.status === 'active'
  );
  if (asTeacher) {
    return `${profileId} is teaching ${asTeacher.studentId} via soft TA transfer.`;
  }
  return '';
}
