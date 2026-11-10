import nodemailer from "nodemailer";
import { getServerSetting } from "../modules/settings/settings";

export type Mail = { to: string; subject: string; text: string; html?: string };

/**
 * SMTP from the admin settings (smtp.*). Built per send: mail volume is low and
 * settings changes then apply without a restart.
 */
export async function sendMail(mail: Mail): Promise<void> {
	const [host, port, secure, user, password, from] = await Promise.all([
		getServerSetting<string>("smtp.host"),
		getServerSetting<number>("smtp.port"),
		getServerSetting<boolean>("smtp.secure"),
		getServerSetting<string>("smtp.user"),
		getServerSetting<string>("smtp.password"),
		getServerSetting<string>("smtp.from"),
	]);
	if (!host) throw new Error("SMTP is not configured");
	const transport = nodemailer.createTransport({
		host,
		port: port ?? 587,
		secure: secure ?? false,
		auth: user ? { user, pass: password ?? "" } : undefined,
		connectionTimeout: 10_000,
		greetingTimeout: 10_000,
		socketTimeout: 20_000,
	});
	await transport.sendMail({ from: from || "no-reply@localhost", ...mail });
}
