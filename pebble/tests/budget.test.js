const { Budget } = require('../src/pkjs/budget');

function fakeStorage() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

function makeBudget(clock, storage) {
  return new Budget({ now: () => clock.t, storage, limit: 17, windowMs: 300000 });
}

test('allows calls up to the limit then refuses', () => {
  const clock = { t: 1000000 };
  const b = makeBudget(clock, fakeStorage());
  for (let i = 0; i < 17; i++) {
    expect(b.allow()).toBe(true);
    b.record();
  }
  expect(b.allow()).toBe(false);
  expect(b.used()).toBe(17);
});

test('allows again once calls age out of the window', () => {
  const clock = { t: 1000000 };
  const b = makeBudget(clock, fakeStorage());
  for (let i = 0; i < 17; i++) { b.record(); }
  expect(b.allow()).toBe(false);
  clock.t += 300001;
  expect(b.allow()).toBe(true);
  expect(b.used()).toBe(0);
});

test('ages out calls individually, not all at once', () => {
  const clock = { t: 1000000 };
  const b = makeBudget(clock, fakeStorage());
  b.record();
  clock.t += 200000;
  for (let i = 0; i < 16; i++) { b.record(); }
  expect(b.allow()).toBe(false);
  clock.t += 100001;          // first call now older than 5 min, rest are not
  expect(b.used()).toBe(16);
  expect(b.allow()).toBe(true);
});

test('survives a storage round trip', () => {
  const clock = { t: 1000000 };
  const storage = fakeStorage();
  const a = makeBudget(clock, storage);
  for (let i = 0; i < 17; i++) { a.record(); }
  const b = makeBudget(clock, storage);
  expect(b.allow()).toBe(false);
});

test('treats corrupt storage as an empty ledger', () => {
  const clock = { t: 1000000 };
  const storage = fakeStorage();
  storage.setItem('fb.budget', 'not json');
  const b = makeBudget(clock, storage);
  expect(b.allow()).toBe(true);
  expect(b.used()).toBe(0);
});
