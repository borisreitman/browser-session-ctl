export const DEFAULT_PORT = 8765;
export const DEFAULT_HOST = "127.0.0.1";

export function port() {
  return Number(process.env.BROWSER_SESSION_CTL_PORT || DEFAULT_PORT);
}

export function origin() {
  return `http://${DEFAULT_HOST}:${port()}`;
}
