// Worker thread for a fixture-library import. Parsing ~21k personalities and
// writing them to SQLite is minutes of synchronous work on a Pi; running it here
// keeps the main thread (DMX output, OSC, web UI) responsive throughout.

const { parentPort, workerData } = require("worker_threads");
const { importLibrary } = require("./import");

importLibrary(workerData.exePath, workerData.dbPath, (p) => parentPort.postMessage({ type: "progress", progress: p }))
  .then((result) => parentPort.postMessage({ type: "done", result }))
  .catch((err) => parentPort.postMessage({ type: "error", message: err.message }));
