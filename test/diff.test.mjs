import test from 'node:test';
import assert from 'node:assert/strict';

import { diffRaw } from '../src/lib/diff.js';
import { fieldLabel, formatValue, somtodayCreatedAt } from '../src/lib/describe.js';

const basis = {
  id: 'x1',
  titel: 'Werkstuk PO',
  omschrijving: 'Kies een onderwerp.',
  deadline: '2026-11-20T22:59:00.000Z',
  vak: { naam: 'Nederlands' },
  bijlagen: [],
  _links: { self: { href: '/rest/v1/huiswerk/x1' } },
  laatstGewijzigdOp: '2026-11-04T09:00:00.000Z',
};

test('ziet een gewijzigde deadline', () => {
  const changes = diffRaw(basis, { ...basis, deadline: '2026-11-21T22:59:00.000Z' });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, 'deadline');
  assert.equal(changes[0].from, '2026-11-20T22:59:00.000Z');
  assert.equal(changes[0].to, '2026-11-21T22:59:00.000Z');
  assert.equal(fieldLabel(changes[0].path), 'Deadline');
});

test('negeert velden die Somtoday altijd bijwerkt', () => {
  const ververst = {
    ...basis,
    laatstGewijzigdOp: '2026-11-05T10:00:00.000Z',
    _links: { self: { href: '/rest/v1/huiswerk/x1?cache=2' } },
  };

  assert.deepEqual(diffRaw(basis, ververst), []);
});

test('ziet een gewijzigde omschrijving', () => {
  const changes = diffRaw(basis, { ...basis, omschrijving: 'Kies een boek.' });
  assert.equal(changes.length, 1);
  assert.equal(fieldLabel(changes[0].path), 'Omschrijving');
});

test('ziet een gewijzigd vak als genest veld', () => {
  const changes = diffRaw(basis, { ...basis, vak: { naam: 'Engels' } });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, 'vak.naam');
  assert.equal(changes[0].from, 'Nederlands');
  assert.equal(changes[0].to, 'Engels');
  assert.equal(fieldLabel(changes[0].path), 'Vak');
});

test('ziet een toegevoegde bijlage', () => {
  const changes = diffRaw(basis, {
    ...basis,
    bijlagen: [{ naam: 'opdracht.pdf', id: 'b1' }],
  });

  assert.ok(changes.length >= 1);
  assert.match(changes[0].path, /^bijlagen\[0\]/);
  assert.match(changes[0].to, /opdracht\.pdf/);
  assert.equal(fieldLabel(changes[0].path), 'Bijlage');
});

test('ziet een lijst met losse waarden', () => {
  const voor = { ...basis, trefwoorden: ['poëzie'] };
  const na = { ...basis, trefwoorden: ['poëzie', 'proza'] };
  const changes = diffRaw(voor, na);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, 'trefwoorden');
});

test('ziet leegmaken en null-waarden', () => {
  const changes = diffRaw({ ...basis, docent: 'Mevrouw Jansen' }, { ...basis, docent: '' });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].to, '');

  const nullChanges = diffRaw({ ...basis, lokaal: null }, { ...basis, lokaal: 'B4' });
  assert.equal(nullChanges.length, 1);
});

test('identieke objecten geven geen wijzigingen', () => {
  assert.deepEqual(diffRaw(basis, { ...basis }), []);
  assert.deepEqual(diffRaw(basis, JSON.parse(JSON.stringify(basis))), []);
});

test('leest een aanmaakdatum uit de ruwe payload', () => {
  assert.equal(
    somtodayCreatedAt({ createdAt: '2026-11-01T10:00:00.000Z' }),
    Date.parse('2026-11-01T10:00:00.000Z'),
  );
  assert.equal(somtodayCreatedAt({ aangemaaktOp: 1763000000 }), 1763000000 * 1000);
  assert.equal(somtodayCreatedAt({ titel: 'x', deadline: '2026-11-20' }), null);
  assert.equal(somtodayCreatedAt(null), null);
});

test('waarde-opmaak is leesbaar', () => {
  assert.equal(formatValue('deadline', '2026-11-21T22:59:00.000Z').includes('21-11-2026'), true);
  assert.equal(formatValue('deadline', ''), '(leeg)');
  assert.equal(formatValue('inleverbaar', false), 'nee');
  assert.equal(formatValue('bijlagen', '2'), '2 bijlagen');
  assert.equal(fieldLabel('inleverbaar'), 'Inleveren');
});
