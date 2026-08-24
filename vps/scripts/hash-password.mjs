#!/usr/bin/env node
import { pbkdf2, randomBytes } from "node:crypto";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
if (password.length < 12 || password.length > 128 || Buffer.byteLength(password, "utf8") > 512) {
  console.error("Password must contain 12-128 characters and no more than 512 UTF-8 bytes.");
  process.exit(1);
}
const iterations = 600_000;
const salt = randomBytes(16);
const digest = await new Promise((resolve, reject) => pbkdf2(password, salt, iterations, 32, "sha256", (error, value) => error ? reject(error) : resolve(value)));
process.stdout.write(`pbkdf2-sha256$${iterations}$${salt.toString("hex")}$${digest.toString("hex")}`);
