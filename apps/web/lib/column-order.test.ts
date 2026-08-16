import { expect, test } from 'bun:test';

import { dropInOrder, moveInOrder } from '@/lib/column-order';

const order = ['select', 'name', 'startsAt', 'endsAt', 'status'];

test('moves a column one position earlier', () => {
  expect(moveInOrder(order, 'endsAt', -1)).toEqual(['select', 'name', 'endsAt', 'startsAt', 'status']);
});

test('moves a column one position later', () => {
  expect(moveInOrder(order, 'name', 1)).toEqual(['select', 'startsAt', 'name', 'endsAt', 'status']);
});

test('refuses to move the first column earlier or the last column later', () => {
  expect(moveInOrder(order, 'select', -1)).toEqual(order);
  expect(moveInOrder(order, 'status', 1)).toEqual(order);
});

test('leaves the order alone for an unknown column', () => {
  expect(moveInOrder(order, 'nope', 1)).toEqual(order);
  expect(dropInOrder(order, 'nope', 'name')).toEqual(order);
  expect(dropInOrder(order, 'name', 'nope')).toEqual(order);
});

test('never mutates the order it was given', () => {
  const original = [...order];
  moveInOrder(order, 'name', 1);
  dropInOrder(order, 'status', 'name');
  expect(order).toEqual(original);
});

test('drops a column onto a later target, closing the gap behind it', () => {
  // 'name' lands where 'status' was; everything between shifts one left rather
  // than the two simply swapping places.
  expect(dropInOrder(order, 'name', 'status')).toEqual(['select', 'startsAt', 'endsAt', 'status', 'name']);
});

test('drops a column onto an earlier target, pushing the target right', () => {
  expect(dropInOrder(order, 'status', 'name')).toEqual(['select', 'status', 'name', 'startsAt', 'endsAt']);
});

test('dropping a column onto itself changes nothing', () => {
  expect(dropInOrder(order, 'name', 'name')).toEqual(order);
});

test('a full sweep of single moves reverses the whole order', () => {
  // Proves the moves compose and conserve the set: pulling each column to the
  // front in turn, in the original left-to-right order, reverses the list —
  // the last one pulled ends up first. Nothing is lost or duplicated on the way.
  //
  // The step budget is not decoration. `moveInOrder(-1)` is what walks a column
  // toward the front, so an implementation that moved it the other way would
  // never satisfy the loop condition: unbounded, this test would hang the suite
  // instead of failing it.
  let current = [...order];
  let budget = order.length * order.length;
  for (const columnId of order) {
    while (current.indexOf(columnId) > 0 && budget > 0) {
      current = moveInOrder(current, columnId, -1);
      budget -= 1;
    }
  }
  expect(budget).toBeGreaterThan(0);
  expect(current).toEqual([...order].reverse());
});
