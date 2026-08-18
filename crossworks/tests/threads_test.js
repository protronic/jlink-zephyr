/*
 * Mock harness for crossworks/zephyr_threads.js.
 *
 * Stubs the CrossStudio Threads/Debug/TargetInterface objects and runs the
 * script against a synthetic target memory image with a made up struct
 * k_thread layout, so the parts that are easy to get wrong - PendSV stack
 * unwinding, FPU frame, xPSR bit 9 alignment, state decoding - are covered
 * without hardware.
 *
 * Run with:  node crossworks/tests/threads_test.js
 *
 * SPDX-License-Identifier: Apache-2.0
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* --- synthetic struct k_thread layout (offsets we pretend DWARF reports) */
const O = {
  'base.prio':              0x10,
  'base.thread_state':      0x11,
  'callee_saved.v1':        0x20,
  'callee_saved.psp':       0x40,
  'next_thread':            0x44,
  'name':                   0x48,
  'arch.mode_exc_return':   0x70,
};

const MEM = new Map();          /* addr(word-aligned) -> u32 */
function w32(a, v) { MEM.set(a >>> 0, v >>> 0); }
function r32(a)    { return MEM.get(a >>> 0) === undefined ? 0 : MEM.get(a >>> 0); }
function wstr(a, s) {
  const b = Buffer.alloc(Math.ceil((s.length + 1) / 4) * 4);
  b.write(s, 'ascii');
  for (let i = 0; i < b.length; i += 4) w32(a + i, b.readUInt32LE(i));
}
function wbyte(a, v) {
  const base = a & ~3, sh = (a & 3) * 8;
  w32(base, (r32(base) & ~(0xff << sh)) | ((v & 0xff) << sh));
}

let POST_KERNEL = 1;
let CURRENT = 0;
let HEAD = 0;
let LIVE = null;         /* live register array or null */
let CONTROL = 2;         /* SPSEL=1 -> thread mode */
let HAS_EXC_RETURN = true;
let HAS_NAME = true;

/* --- mock CrossStudio API ------------------------------------------- */
const rows = [];
const queues = [];
const Threads = {
  cols: null,
  setColumns: function () { Threads.cols = Array.prototype.slice.call(arguments); },
  setSortByNumber: function () {},
  clear: function () { rows.length = 0; queues.length = 0; },
  newqueue: function (n) { queues.push(n); },
  add: function () {
    const a = Array.prototype.slice.call(arguments);
    if (Threads.cols && a.length !== Threads.cols.length + 1)
      throw new Error('column mismatch: ' + a.length + ' args for ' +
                      Threads.cols.length + ' columns');
    rows.push({ queue: queues[queues.length - 1], cols: a.slice(0, -1),
                handle: a[a.length - 1] });
  },
};

const TargetInterface = {
  peekWord: function (a) { return r32(a); },
  getRegister: function (n) {
    if (n === 'CONTROL') return CONTROL;
    if (LIVE === null) throw new Error('no live regs');
    const names = ['r0','r1','r2','r3','r4','r5','r6','r7','r8','r9','r10',
                   'r11','r12','sp','lr','pc','xpsr'];
    const i = names.indexOf(n);
    if (i < 0) throw new Error('unknown reg ' + n);
    return LIVE[i];
  },
};

const Debug = {
  evaluate: function (expr) {
    let m;
    if (expr === 'z_sys_post_kernel') return POST_KERNEL;
    if (expr === '(unsigned long)_kernel.cpus[0].current') return CURRENT;
    if (expr === '(unsigned long)_kernel.threads') return HEAD;
    m = expr.match(/^\(unsigned long\)&\(\(struct k_thread \*\)0\)->(.+)$/);
    if (m) {
      if (m[1] === 'name' && !HAS_NAME) throw new Error('no field');
      if (m[1] === 'arch.mode_exc_return' && !HAS_EXC_RETURN) throw new Error('no field');
      if (O[m[1]] === undefined) throw new Error('no field ' + m[1]);
      return '0x' + O[m[1]].toString(16);
    }
    m = expr.match(/^\*\(unsigned long \*\)(0x[0-9a-f]+)$/);
    if (m) return r32(parseInt(m[1], 16));
    throw new Error('unhandled expr: ' + expr);
  },
};

/* --- load script into a sandbox -------------------------------------- */
const src = fs.readFileSync(path.join(__dirname, '..', 'zephyr_threads.js'), 'utf8');
const ctx = vm.createContext({ Threads, TargetInterface, Debug, String, Array, parseInt, isNaN });
vm.runInContext(src, ctx);
const init = ctx.init, update = ctx.update, getregs = ctx.getregs;

/* --- helpers to build a thread --------------------------------------- */
function mkthread(base, name, prio, state, next, psp, excReturn) {
  wbyte(base + O['base.prio'], prio & 0xff);
  wbyte(base + O['base.thread_state'], state);
  w32(base + O['callee_saved.psp'], psp);
  for (let i = 0; i < 8; i++) w32(base + O['callee_saved.v1'] + i * 4, 0x40000 + base + i);
  w32(base + O['next_thread'], next);
  wstr(base + O['name'], name);
  wbyte(base + O['arch.mode_exc_return'], excReturn);
}
function mkframe(psp, xpsr) {
  const vals = [0xa0, 0xa1, 0xa2, 0xa3, 0xac, 0xdeadbee1, 0x08001234, xpsr];
  for (let i = 0; i < 8; i++) w32(psp + i * 4, vals[i]);
}

/* --- tests ------------------------------------------------------------ */
let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log('FAIL ' + name + '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want)); }
  else console.log('ok   ' + name);
}

init();
check('columns', Threads.cols, ['Name', 'Prio', 'State', 'PC', 'Thread']);

/* 1. kernel not started */
POST_KERNEL = 0;
update();
check('kernel not started -> no rows', rows.length, 0);

/* 2. two threads, second one is current & queued */
POST_KERNEL = 1;
const T1 = 0x20001000, T2 = 0x20002000;
const PSP1 = 0x20008000, PSP2 = 0x20009000;
mkthread(T1, 'idle', 15, 1 << 7, T2, PSP1, 0xbd);   /* FType=1 -> basic  */
mkthread(T2, 'main', 0, 1 << 7, 0, PSP2, 0xbd);
mkframe(PSP1, 0x01000000);
mkframe(PSP2, 0x01000000);
HEAD = T1;
CURRENT = T2;
update();
check('thread count', rows.length, 2);
check('names', rows.map(r => r.cols[0]), ['idle', 'main']);
check('prios', rows.map(r => r.cols[1]), ['15', '0']);
check('states', rows.map(r => r.cols[2]), ['QUEUED', 'RUNNING']);
check('handles', rows.map(r => r.handle), [T1, T2]);
check('pc column (non-current)', rows[0].cols[3], '0x8001234');

/* 3. register reconstruction, basic frame, no forced alignment */
let regs = getregs(T1);
check('r0..r3', regs.slice(0, 4), [0xa0, 0xa1, 0xa2, 0xa3]);
check('r4..r11', regs.slice(4, 12), [0, 1, 2, 3, 4, 5, 6, 7].map(i => (0x40000 + T1 + i) >>> 0));
check('r12', regs[12], 0xac);
check('lr', regs[14], 0xdeadbee1);
check('pc', regs[15], 0x08001234);
check('sp basic frame', regs[13], PSP1 + 32);

/* 4. forced 8-byte alignment (xPSR bit 9) */
mkframe(PSP1, 0x01000000 | (1 << 9));
regs = getregs(T1);
check('sp with xpsr bit 9', regs[13], PSP1 + 32 + 4);

/* 5. extended (FPU) frame: EXC_RETURN FType == 0 */
mkframe(PSP1, 0x01000000);
wbyte(T1 + O['arch.mode_exc_return'], 0xad);   /* bit4 clear -> extended */
regs = getregs(T1);
check('sp with FPU frame', regs[13], PSP1 + 32 + 72);

/* 5b. extended frame + forced alignment */
mkframe(PSP1, 0x01000000 | (1 << 9));
regs = getregs(T1);
check('sp FPU + alignment', regs[13], PSP1 + 32 + 72 + 4);
wbyte(T1 + O['arch.mode_exc_return'], 0xbd);
mkframe(PSP1, 0x01000000);

/* 6. no CONFIG_ARM_STORE_EXC_RETURN -> always basic frame */
HAS_EXC_RETURN = false;
update();
regs = getregs(T1);
check('sp without exc_return field', regs[13], PSP1 + 32);
HAS_EXC_RETURN = true;

/* 7. no CONFIG_THREAD_NAME */
HAS_NAME = false;
update();
check('fallback name', rows[0].cols[0], 'thread@0x20001000');
HAS_NAME = true;

/* 8. handler mode pseudo thread */
CONTROL = 0;
LIVE = [1,2,3,4,5,6,7,8,9,10,11,12,13, 0x2000ff00, 0xfffffff9, 0x08000700, 0x01000003];
update();
check('handler pseudo thread appended', rows.length, 3);
check('handler name', rows[2].cols[0], 'EXCEPTION/INTERRUPT');
check('handler regs are live', getregs(rows[2].handle), LIVE);
check('current thread regs are live', getregs(T2), LIVE);
CONTROL = 2;

/* 9. state decoding priority chain */
const cases = [
  [1 << 2, 'NOT STARTED'], [1 << 4, 'SUSPENDED'], [1 << 1, 'PENDING'],
  [1 << 5, 'ABORTING'], [1 << 3, 'DEAD'], [0, 'UNKNOWN'],
  [(1 << 7) | (1 << 1), 'PENDING'],       /* PENDING wins over QUEUED */
  [(1 << 4) | (1 << 1), 'SUSPENDED'],     /* SUSPENDED wins over PENDING */
];
LIVE = null;
for (const [bits, want] of cases) {
  wbyte(T1 + O['base.thread_state'], bits);
  update();
  check('state 0x' + bits.toString(16), rows[0].cols[2], want);
}

/* 10. psp == 0 (never switched out) must not invent a stack */
wbyte(T1 + O['base.thread_state'], 1 << 2);
w32(T1 + O['callee_saved.psp'], 0);
update();
regs = getregs(T1);
check('psp=0 -> zeroed regs', regs, new Array(17).fill(0));
check('psp=0 -> empty pc column', rows[0].cols[3], '');

/* 11. circular list must not hang */
w32(T1 + O['callee_saved.psp'], PSP1);
w32(T2 + O['next_thread'], T1);
update();
check('circular list bounded', rows.length, 257);
check('truncation reported', rows[256].cols[0], '<thread list truncated after 256 entries>');
w32(T2 + O['next_thread'], 0);

console.log(fails ? '\n' + fails + ' FAILURES' : '\nall passed');
process.exit(fails ? 1 : 0);
