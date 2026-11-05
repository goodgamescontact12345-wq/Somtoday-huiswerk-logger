import test from 'node:test';
import assert from 'node:assert/strict';

import {
  endpointKeyOf,
  extractFromPayload,
  normalizeCandidate,
  scoreCandidate,
} from '../src/lib/extract.js';

const HUISWERK_URL =
  'https://school.somtoday.nl/rest/v1/studiewijzers/abc/huiswerk?additional=opdracht';

const huiswerkPayload = {
  items: [
    {
      id: 'a1b2c3',
      titel: 'Paragraaf 4.2 opdrachten 1 t/m 8',
      omschrijving: 'Maak de opdrachten in je schrift.',
      deadline: '2026-11-12T22:59:00.000Z',
      vak: { naam: 'Wiskunde' },
      bijlagen: [],
      _links: { self: { href: '/rest/v1/huiswerk/a1b2c3' } },
      laatstGewijzigdOp: '2026-11-04T09:12:00.000Z',
    },
    {
      id: 'd4e5f6',
      titel: 'Boekverslag',
      omschrijving: 'Inleveren via de ELO.',
      deadline: '2026-11-20',
      vak: { naam: 'Nederlands' },
    },
  ],
  totalCount: 2,
};

test('herkent huiswerk in een studiewijzer-payload', () => {
  const { endpointKey, records } = extractFromPayload(huiswerkPayload, HUISWERK_URL);

  assert.equal(endpointKey, '/rest/v1/studiewijzers/abc/huiswerk?additional=opdracht');
  assert.equal(records.length, 2);

  const [eerste, tweede] = records;
  assert.equal(eerste.key, 'id:a1b2c3');
  assert.equal(eerste.identity, 'id');
  assert.equal(eerste.fields.vak, 'Wiskunde');
  assert.equal(eerste.fields.titel, 'Paragraaf 4.2 opdrachten 1 t/m 8');
  assert.equal(eerste.fields.deadline, '2026-11-12T22:59:00.000Z');
  assert.equal(eerste.fields.deadlineIso, Date.parse('2026-11-12T22:59:00.000Z'));
  assert.equal(eerste.fields.bijlagen, 0);

  assert.equal(tweede.key, 'id:d4e5f6');
  // 'yyyy-mm-dd' zonder tijd: einde van de dag, lokale tijd.
  assert.equal(new Date(tweede.fields.deadlineIso).getDate(), 20);
  assert.equal(new Date(tweede.fields.deadlineIso).getHours(), 23);
});

test('laat lesrooster-items met begintijd/eindtijd met rust', () => {
  const payload = {
    items: [
      {
        id: 'les-1',
        titel: 'Wiskunde',
        begintijd: '2026-11-05T08:30:00',
        eindtijd: '2026-11-05T09:20:00',
        lesuur: 1,
        lokaal: 'A12',
        vak: { naam: 'Wiskunde' },
      },
      {
        id: 'les-2',
        titel: 'Nederlands',
        begintijd: '2026-11-05T09:30:00',
        eindtijd: '2026-11-05T10:20:00',
        lesuur: 2,
        vak: { naam: 'Nederlands' },
      },
    ],
  };

  const { records } = extractFromPayload(payload, 'https://school.somtoday.nl/rest/v1/afspraken');
  assert.equal(records.length, 0);
});

test('dedupliceert hetzelfde item binnen één payload', () => {
  const dubbel = { ...huiswerkPayload.items[0] };
  const { records } = extractFromPayload({ a: [dubbel], b: [dubbel] }, HUISWERK_URL);
  assert.equal(records.length, 1);
});

test('valt terug op een signatuur als er geen id is', () => {
  const zonderId = { ...huiswerkPayload.items[0] };
  delete zonderId.id;

  const { records } = extractFromPayload({ items: [zonderId] }, HUISWERK_URL);
  assert.equal(records.length, 1);
  assert.equal(records[0].identity, 'signature');
  assert.match(records[0].key, /^sig:/);
});

test('signatuur blijft gelijk als alleen de deadline wijzigt', () => {
  const basis = { ...huiswerkPayload.items[0] };
  delete basis.id;
  const gewijzigd = { ...basis, deadline: '2026-11-19T22:59:00.000Z' };

  const a = normalizeCandidate(basis, 'items[0]', 'x');
  const b = normalizeCandidate(gewijzigd, 'items[0]', 'x');
  assert.equal(a.key, b.key);
});

test('negeert objecten zonder huiswerk-kenmerken', () => {
  const verdict = scoreCandidate({ kleur: 'rood', aantal: 3 }, 'instellingen');
  assert.equal(verdict.isHomework, false);
});

test('endpointKey negeert cache-busters en sorteert parameters', () => {
  const a = endpointKeyOf('https://school.somtoday.nl/rest/v1/huiswerk?_=1699&sort=datum');
  const b = endpointKeyOf('https://school.somtoday.nl/rest/v1/huiswerk?sort=datum');
  const c = endpointKeyOf('https://school.somtoday.nl/rest/v1/huiswerk?sort=datum&page=2');

  assert.equal(a, b);
  assert.notEqual(b, c);
  assert.equal(b, '/rest/v1/huiswerk?sort=datum');
});

test('lege of onbruikbare payloads geven geen records', () => {
  assert.deepEqual(extractFromPayload(null, HUISWERK_URL).records, []);
  assert.deepEqual(extractFromPayload('geen json', HUISWERK_URL).records, []);
  assert.deepEqual(extractFromPayload({ items: [] }, HUISWERK_URL).records, []);
});
