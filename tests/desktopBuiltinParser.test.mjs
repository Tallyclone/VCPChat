import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDesktopBuiltinBlock } from '../modules/renderer/desktopBuiltinParser.js';

test('parseDesktopBuiltinBlock supports aliases, arrays, and customUI defaults', () => {
  const payload = parseDesktopBuiltinBlock(`
    name: Native Mount
    id: widget-001
    type: nativeFileMount
    path: C:/demo
    mode: readwrite
    view: grid
    ui.toolbar: open, refresh, separator, paste
    ui.contextMenu: open, rename
    ui.confirm.buttonOrder: cancel, confirm
    customUI.html: <div>ok</div>
  `);

  assert.equal(payload.title, 'Native Mount');
  assert.equal(payload.widgetId, 'widget-001');
  assert.equal(payload.type, 'nativeFileMount');
  assert.equal(payload.config.mountPath, 'C:/demo');
  assert.equal(payload.config.mode, 'readwrite');
  assert.equal(payload.config.initialView, 'grid');
  assert.deepEqual(payload.config.ui.actions.toolbar, ['open', 'refresh', 'separator', 'paste']);
  assert.deepEqual(payload.config.ui.actions.contextMenu, ['open', 'rename']);
  assert.deepEqual(payload.config.ui.confirm.buttonOrder, ['cancel', 'confirm']);
  assert.equal(payload.customUI.runtime, 'vcp-widget-shadow');
  assert.equal(payload.customUI.version, 2);
  assert.equal(payload.customUI.html, '<div>ok</div>');
});

test('parseDesktopBuiltinBlock handles escaped blocks and validates required mountPath', () => {
  const payload = parseDesktopBuiltinBlock(`
    type: nativeFileMount
    title: Escape Demo
    mountPath:「始ESCAPE」C:/Data/Docs「末ESCAPE」
    notes:「始」
    line one
    line two
    「末」
  `);

  assert.equal(payload.config.mountPath, 'C:/Data/Docs');
  assert.deepEqual(
    payload.config.notes.split('\n').map((line) => line.trim()),
    ['line one', 'line two']
  );
  assert.throws(() => parseDesktopBuiltinBlock('type: nativeFileMount'), /requires mountPath/);
  assert.throws(() => parseDesktopBuiltinBlock('title: missing type'), /requires type/);
});
