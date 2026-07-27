declare module 'nodemailer' {
  export type Transporter = any;
  const nodemailer: {
    createTransport: (...args: any[]) => Transporter;
  };
  export default nodemailer;
}

