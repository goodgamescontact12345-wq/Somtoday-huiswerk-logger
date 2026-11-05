import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MATCH_THRESHOLD,
  idCandidatesFromUrl,
  rankAssignments,
  scoreAssignment,
} from '../src/lib/match.js';

const wiskunde = {
  key: 'id:1234567',
  fields: {
    titel: 'Paragraaf 4.2 opdrachten 1 t/m 8',
    vak: 'Wiskunde',
    omschrijving: 'Maak de opdrachten 1 t/m 8 in je schrift.',
  },
};

test('een id in de URL wint van alle tekstsignalen', () => {
  const page = { url: 'https://school.somtoday.nl/huiswerk/1234567', text: 'Huiswerk Wiskunde' };
  assert.ok(scoreAssignment(wiskunde, page) >= 100);

  const ander = { key: 'id:999999', fields: { titel: 'Iets anders', vak: 'Frans' } };
  const ranked = rankAssignments([ander, wiskunde], page);
  assert.equal(ranked[0].assignment.key, 'id:1234567');
});

test('titel die letterlijk op de pagina staat is genoeg', () => {
  const page = {
    url: 'https://school.somtoday.nl/studiewijzer',
    text: 'Huiswerk Paragraaf 4.2 opdrachten 1 t/m 8 — Wiskunde',
  };
  assert.ok(scoreAssignment(wiskunde, page) >= MATCH_THRESHOLD);
});

test('een onherkenbare pagina levert geen kandidaten op', () => {
  const page = { url: 'https://school.somtoday.nl/rooster', text: 'Maandag: Nederlands, Frans, biologie' };
  assert.deepEqual(rankAssignments([wiskunde], page), []);
  assert.equal(scoreAssignment(wiskunde, { url: '', text: '' }), 0);
});

test('korte titels matchen niet op losse paginatekst', () => {
  const kort = { key: 'sig:abc', fields: { titel: 'PO', vak: 'Aardrijkskunde' } };
  const page = {
    url: 'https://school.somtoday.nl/agenda',
    text: 'PO en nog wat dingen voor aardrijkskunde',
  };
  assert.ok(scoreAssignment(kort, page) < MATCH_THRESHOLD);
});

test('uuid- en numerieke ids uit de URL', () => {
  assert.deepEqual(
    idCandidatesFromUrl('https://s.somtoday.nl/huiswerk/1a2b3c4d-1111-2222-3333-444455556666'),
    ['1a2b3c4d-1111-2222-3333-444455556666'],
  );
  assert.deepEqual(idCandidatesFromUrl('https://s.somtoday.nl/x/detail/7654321?foo=1'), ['7654321']);
  assert.deepEqual(idCandidatesFromUrl('niet een url'), []);
});

test('rangschikt op score en respecteert de limiet', () => {
  const page = {
    url: 'https://s.somtoday.nl/huiswerk/1234567',
    text: 'Paragraaf 4.2 opdrachten 1 t/m 8',
  };
  const ranked = rankAssignments([wiskunde], page, 1);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].assignment.key, 'id:1234567');
  assert.ok(ranked[0].score >= MATCH_THRESHOLD);
});
