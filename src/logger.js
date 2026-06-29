// Tiny leveled logger. Writes to stdout/stderr so journald (systemd) captures it.
// View live with: journalctl -u scene-setter -f

function ts() {
  return new Date().toISOString();
}

module.exports = {
  info: (...args) => console.log(ts(), "INFO ", ...args),
  warn: (...args) => console.warn(ts(), "WARN ", ...args),
  error: (...args) => console.error(ts(), "ERROR", ...args),
};
