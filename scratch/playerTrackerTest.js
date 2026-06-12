// Verifies PlayerTracker parses join/leave + Java/Bedrock platform from console.
const { PlayerTracker } = require('../dist/dashboard/playerTracker');

let last = [];
const fakePM = {
  cb: null,
  subscribeConsole(_name, cb) { this.cb = cb; return () => { this.cb = null; }; },
  sendCommand() { return true; },
  feed(line) { this.cb && this.cb(line); },
};

const tracker = new PlayerTracker(fakePM, 'srv', (players) => { last = players; });
tracker.start();

const checks = [];
const find = (n) => last.find((p) => p.name === n);

fakePM.feed('[12:00:00] [Server thread/INFO]: Notch joined the game\n');
checks.push(['Java join detected', !!find('Notch') && find('Notch').platform === 'java']);

fakePM.feed('[12:00:01] [Server thread/INFO]: .BedrockGuy joined the game\n');
checks.push(['Bedrock join tagged', !!find('.BedrockGuy') && find('.BedrockGuy').platform === 'bedrock']);

fakePM.feed('[12:00:02] [Server thread/INFO]: Notch left the game\n');
checks.push(['leave removes player', !find('Notch')]);

fakePM.feed('[12:00:03] [Server thread/INFO]: There are 2 of a max of 20 players online: Alice, .Bob\n');
checks.push(['list reconcile resets roster', last.length === 2 && !!find('Alice') && find('.Bob').platform === 'bedrock']);

tracker.stop();

let ok = true;
for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
process.exitCode = ok ? 0 : 1;
