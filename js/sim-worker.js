// Web Worker for supercomputer mode. Receives a job once, then batches of run
// indices; replies with the aggregate for each batch (the main thread merges).
importScripts('util.js', 'formations.js', 'commentary.js', 'engine.js', 'sim.js');

let job = null;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'job') {
    job = msg.job;
  } else if (msg.type === 'batch') {
    const agg = self.OF.sim.createAgg();
    for (let i = msg.start; i < msg.end; i++) self.OF.sim.simulateRun(job, i, agg);
    self.postMessage({ type: 'batch', agg, start: msg.start, end: msg.end });
  }
};
