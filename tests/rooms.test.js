const test = require("node:test");
const { after } = test;
const assert = require("node:assert/strict");
const { io: connect } = require("socket.io-client");
const { server, io, rooms } = require("../server");

after(() => {
  rooms.forEach((room) => { clearTimeout(room.timer); clearTimeout(room.hostGrace); });
  io.close();
});

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function nextEvent(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

test("host and participant complete a live room lifecycle", async (t) => {
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${server.address().port}`;
  const sockets = [];
  const client = () => {
    const socket = connect(url, { transports: ["websocket"], forceNew: true });
    sockets.push(socket);
    return socket;
  };
  t.after(() => {
    sockets.forEach((socket) => socket.close());
  });

  const host = client();
  const created = await emit(host, "host:create", {
    type: "sequence",
    prompt: "Ordena",
    items: ["Uno", "Dos", "Tres"],
    theme: "blue",
  });
  const code = created.room.code;
  assert.equal(created.room.status, "lobby");

  const guest = client();
  const joined = await emit(guest, "participant:join", { code, name: "Ana" });
  assert.equal(joined.status, "lobby");
  assert.equal(joined.activity, undefined);

  const early = await emit(guest, "participant:submit", { answer: ["Uno", "Dos", "Tres"] });
  assert.match(early.error, /no está recibiendo/);

  const started = nextEvent(guest, "room:state");
  host.emit("host:start");
  const live = await started;
  assert.equal(live.status, "live");
  assert.equal(live.activity.items.length, 3);

  const submitted = await emit(guest, "participant:submit", { answer: ["Uno", "Dos", "Tres"] });
  assert.deepEqual(submitted.score, { correct: 3, total: 3 });
  const again = await emit(guest, "participant:submit", { answer: ["Uno", "Dos", "Tres"] });
  assert.match(again.error, /Ya enviaste/);

  const reconnect = client();
  const rejoined = await emit(reconnect, "participant:join", { code, token: joined.token });
  assert.deepEqual(rejoined.score, { correct: 3, total: 3 });

  const ended = nextEvent(reconnect, "room:state");
  host.emit("host:end");
  const finalState = await ended;
  assert.equal(finalState.status, "ended");
  assert.equal(finalState.rank, 1);
  assert.equal(finalState.leaderboard[0].name, "Ana");

  const closed = nextEvent(reconnect, "room:closed");
  host.emit("host:close");
  await closed;
  assert.equal(rooms.has(code), false);
});

test("kicked participants cannot rejoin with their token", async (t) => {
  await new Promise((resolve) => (server.listening ? resolve() : server.listen(0, resolve)));
  const url = `http://localhost:${server.address().port}`;
  const host = connect(url, { transports: ["websocket"], forceNew: true });
  const guest = connect(url, { transports: ["websocket"], forceNew: true });
  t.after(() => { host.close(); guest.close(); });

  const { room } = await emit(host, "host:create", { type: "sequence", prompt: "P", items: ["A", "B"] });
  const joined = await emit(guest, "participant:join", { code: room.code, name: "Beto" });
  const update = nextEvent(host, "room:update");
  const kicked = nextEvent(guest, "room:kicked");
  const summary = await update;
  host.emit("host:kick", { id: summary.participants[0].id });
  await kicked;

  const retry = connect(url, { transports: ["websocket"], forceNew: true });
  t.after(() => retry.close());
  const result = await emit(retry, "participant:join", { code: room.code, token: joined.token, name: "Beto" });
  assert.match(result.error, /retiró/);
});
