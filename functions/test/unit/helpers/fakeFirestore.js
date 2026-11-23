"use strict";
// A small in-memory Firestore for unit tests: documents, queries with
// where/orderBy/startAfter/limit, and transactions that run one at a time and
// write all or nothing. `fail(regex, times)` makes writes to a path throw.
class Timestamp {
  constructor(seconds, nanoseconds) {
    if (!Number.isInteger(seconds) || seconds < -62135596800 || seconds > 253402300799) throw new Error("seconds out of range");
    this.seconds = seconds; this.nanoseconds = nanoseconds;
  }
  static fromMillis(ms) { const s = Math.floor(ms / 1000); return new Timestamp(s, Math.round((ms - s * 1000) * 1e6)); }
  static now() { return Timestamp.fromMillis(Date.now()); }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
}
const NOW = Symbol("now"); const DEL = Symbol("delete");
const FieldValue = {serverTimestamp: () => NOW, delete: () => DEL, increment: (n) => ({inc: n})};
const big = (v) => (v instanceof Timestamp ? BigInt(v.seconds) * 1000000000n + BigInt(v.nanoseconds) : v);
const cmp = (a, b) => (big(a) < big(b) ? -1 : big(a) > big(b) ? 1 : 0);

function fakeFirestore(seed = {}) {
  const store = new Map(Object.entries(seed));
  const writes = []; const failing = [];
  let auto = 0;
  const check = (p) => { for (const f of failing) if (f.n > 0 && f.re.test(p)) { f.n--; throw new Error("UNAVAILABLE " + p); } };
  const merge = (cur, d) => {
    const out = {...cur};
    for (const [k, v] of Object.entries(d)) {
      if (v === DEL) delete out[k];
      else if (v === NOW) out[k] = Timestamp.now();
      else if (v && typeof v === "object" && "inc" in v) out[k] = (Number(out[k]) || 0) + v.inc;
      else out[k] = v;
    }
    return out;
  };
  const apply = (op, p, d, o) => {
    writes.push({op, path: p});
    if (op === "create" && store.has(p)) throw new Error("ALREADY_EXISTS " + p);
    if (op === "update" && !store.has(p)) throw new Error("NOT_FOUND " + p);
    if (op === "delete") store.delete(p);
    else store.set(p, merge(op === "update" || (o && o.merge) ? store.get(p) || {} : {}, d));
  };
  const ref = (p) => {
    const write = (op) => async (d, o) => { check(p); apply(op, p, d, o); };
    return {path: p, id: p.split("/").pop(), get: async () => snap(p), set: write("set"), update: write("update"), create: write("create"),
      delete: write("delete"), collection: (c) => collection(`${p}/${c}`)};
  };
  const snap = (p) => { const d = store.get(p); return {exists: store.has(p), id: p.split("/").pop(), ref: ref(p), data: () => (d ? {...d} : undefined)}; };
  function query(c, st) {
    const q = {
      where: (f, op, v) => query(c, {...st, where: [...st.where, [f, op, v]]}),
      orderBy: (f) => query(c, {...st, order: [...st.order, f]}),
      startAfter: (...a) => query(c, {...st, after: a}),
      limit: (n) => query(c, {...st, limit: n}),
      get: async () => {
        const depth = c.split("/").length + 1;
        let rows = [...store.keys()].filter((p) => p.startsWith(c + "/") && p.split("/").length === depth).map(snap);
        const val = (s, f) => (f === "__name__" ? s.id : s.data()[f]);
        for (const [f, op, v] of st.where) {
          rows = rows.filter((s) => { const x = val(s, f); return op === "==" ? x === v : x !== undefined && cmp(x, v) >= 0; });
        }
        const order = (a, b) => { for (const f of st.order) { const r = cmp(val(a, f), val(b, f)); if (r) return r; } return 0; };
        rows = rows.filter((s) => st.order.every((f) => val(s, f) !== undefined)).sort(order);
        if (st.after) {
          rows = rows.filter((s) => { for (let i = 0; i < st.order.length; i++) { const r = cmp(val(s, st.order[i]), st.after[i]); if (r) return r > 0; } return false; });
        }
        if (st.limit) rows = rows.slice(0, st.limit);
        return {docs: rows, size: rows.length, empty: !rows.length, forEach: (f) => rows.forEach(f)};
      },
    };
    return q;
  }
  function collection(c) {
    return {...query(c, {where: [], order: []}), doc: (id) => ref(`${c}/${id || "auto" + (++auto)}`),
      add: async (d) => { const r = ref(`${c}/auto${++auto}`); await r.set(d); return r; }};
  }
  const writer = (ops) => Object.fromEntries(["create", "set", "update", "delete"].map((op) =>
    [op, (r, d, o) => { ops.push([op, r.path, d, o]); }]));
  const commit = (ops) => {
    for (const [, p] of ops) check(p);
    for (const [op, p] of ops) {
      if (op === "create" && store.has(p)) throw new Error("ALREADY_EXISTS " + p);
      if (op === "update" && !store.has(p) && !ops.some(([o, q]) => q === p && o !== "update")) throw new Error("NOT_FOUND " + p);
    }
    for (const [op, p, d, o] of ops) apply(op, p, d, o);
  };
  let lock = Promise.resolve();
  const db = {
    doc: ref, collection,
    getAll: async (...refs) => refs.map((r) => snap(r.path)),
    batch: () => { const ops = []; return {...writer(ops), commit: async () => commit(ops)}; },
    runTransaction: (fn) => {
      const run = lock.then(async () => {
        const ops = [];
        const r = await fn({...writer(ops), get: async (x) => {
          if (ops.length) throw new Error("reads before writes");
          return snap(x.path);
        }, getAll: async (...refs) => {
          if (ops.length) throw new Error("reads before writes");
          return refs.map((r2) => snap(r2.path));
        }});
        commit(ops);
        return r;
      });
      lock = run.catch(() => {});
      return run;
    },
  };
  return {db, store, writes, fail: (re, n = 1) => failing.push({re, n}), list: (c) => [...store.keys()].filter((p) => p.startsWith(c + "/"))};
}

module.exports = {fakeFirestore, Timestamp, FieldValue};
