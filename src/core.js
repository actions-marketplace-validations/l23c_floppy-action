// The few @actions/core pieces this action needs, without the dependency.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EOL } from "node:os";

let write = (s) => process.stdout.write(s);
/** Tests swap the writer so workflow commands can be inspected. */
export function setWriter(fn) {
  write = fn;
}

export function getInput(name, env = process.env) {
  const value = env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return (value ?? "").trim();
}

export function getMultilineInput(name, env = process.env) {
  return getInput(name, env)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function escapeData(s) {
  return String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function writeFileCommand(file, name, value) {
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`, "utf8");
}

export function setOutput(name, value, env = process.env) {
  const v = typeof value === "string" ? value : JSON.stringify(value);
  if (env.GITHUB_OUTPUT) writeFileCommand(env.GITHUB_OUTPUT, name, v);
  else write(`${EOL}::set-output name=${name}::${escapeData(v)}${EOL}`);
}

export function setSecret(value) {
  if (value) write(`::add-mask::${escapeData(value)}${EOL}`);
}

export const info = (msg) => write(`${msg}${EOL}`);
export const warning = (msg) => write(`::warning::${escapeData(msg)}${EOL}`);
export const error = (msg) => write(`::error::${escapeData(msg)}${EOL}`);

export function summary(markdown, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}${EOL}`, "utf8");
}

export function setFailed(msg) {
  process.exitCode = 1;
  error(msg);
}
