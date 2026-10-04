export const DEFAULT_PORT = 8765;
export const DEFAULT_HOST = "127.0.0.1";

export function port() {
  return Number(process.env.BROWSER_SESSION_CTL_PORT || DEFAULT_PORT);
}

export function origin() {
  return `http://${DEFAULT_HOST}:${port()}`;
}

// Which Chrome profile to talk to when several are connected. Set by
// --profile or BROWSER_SESSION_CTL_PROFILE; empty means "the only one".
export function profileFromEnv() {
  return process.env.BROWSER_SESSION_CTL_PROFILE || "";
}
