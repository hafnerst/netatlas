/**
 * Help → User Manual and Help → License: their content, built from text
 * nodes and elements only. The screenshots and the license text are embedded
 * in the page (generated/help-assets.ts), so both work without a network.
 */
import { el } from './dom';
import { LICENSE_TEXT, MANUAL_IMAGES } from '../generated/help-assets';

/** A manual section: a title, short paragraphs or steps, and screenshots with captions. */
interface Section {
  id: string;
  title: string;
  intro?: string;
  steps?: string[];
  notes?: string[];
  figures?: Array<[string, string]>;
}

/**
 * The manual, task by task. Text markup: **bold** for names of controls,
 * `key` for keys. Figures name a file of docs/img/manual (captured from the
 * application by scripts/manual-screenshots.mjs).
 */
const MANUAL: Section[] = [
  {
    id: 'open',
    title: 'Open or create a model',
    intro: 'A model is a YAML file that describes your network. The start screen offers three ways to begin:',
    steps: [
      '**New model** starts an empty model. Add objects with **+ Add** in the object list on the left.',
      '**Open model…** opens a `.yaml` / `.yml` file from this computer. You can also drop a file anywhere on the page.',
      '**Load example**: choose a built-in example and press **Load**.',
    ],
    notes: ['The same commands are in the **File** menu at any time. If the current model has unsaved changes, NetAtlas asks first. Files are read locally; nothing is uploaded.'],
    figures: [['start', 'The start screen: New model, Open model… or Load example.']],
  },
  {
    id: 'save',
    title: 'Save or export a model',
    steps: [
      '**File → Save model as…** (`Ctrl+Shift+S`) saves the model under a name and in a place you choose, and links the model to that file.',
      '**File → Save model** (`Ctrl+S`) then updates the linked file without asking. In browsers without a save picker (Firefox, Safari), *Save model as…* downloads a copy instead.',
      '**Export → Export view as… → PNG** or **SVG** saves the view on screen as a picture: the whole diagram, with its legend and networks overview.',
    ],
    notes: ['A small dot on the file name in the status bar means that there are unsaved changes.'],
    figures: [
      ['file-menu', 'The File menu: new, open, save and close a model, and the examples.'],
      ['export-menu', 'Export → Export view as… with its two formats.'],
    ],
  },
  {
    id: 'views',
    title: 'Navigate the Physical and Logical views',
    intro: 'Every model has two diagrams. Switch between them in the **View** group of the toolbar.',
    steps: [
      '**Physical** (`P`) shows devices, ports and cables, inside their locations.',
      '**Logical** (`L`) shows relations such as tunnels and routing sessions, networks and loopbacks.',
      'Drag the background or use the arrow keys to pan. Zoom with the mouse wheel, `+` / `−`, or **Fit** (`0`) to see everything.',
      'Hover over an object for a short summary. A selection is kept when you switch views.',
    ],
    figures: [
      ['physical', 'The physical view. Toolbar at the top, object list on the left, diagram in the middle, panels (Edit, Details, Legend …) on the right.'],
      ['logical', 'Part of the logical view (metro ring example): routers with their loopbacks, and the iBGP, LDP and RSVP-TE relations between them.'],
    ],
  },
  {
    id: 'find',
    title: 'Find and filter objects',
    steps: [
      '**Find → Find in diagram…** (`/`) opens a search bar over the diagram. Type an ID, label, address, prefix or protocol; press `Enter` or click a match to select it. `Esc` closes the bar.',
      '**Find → Filter object list…** shows a filter box above the object list on the left. It narrows the list only; the diagram is not changed. `Esc` or **×** clears it.',
      'The **Filters** group in the toolbar chooses what the diagram shows: **Devices ▾** for some devices only, and switches for labels, groups, networks, endpoints and servers. Nothing is deleted, and positions in a filtered view are temporary.',
    ],
    figures: [
      ['find', 'Find in diagram: matches are listed as you type.'],
      ['filter-list', 'Filter object list: only the entries that contain the text stay listed.'],
    ],
  },
  {
    id: 'edit',
    title: 'Select and edit objects',
    steps: [
      'Click an object in the diagram or in the object list. The **Edit** tab on the right opens it; **Details** gives a read-only summary.',
      'Type in a field. A change applies when you press `Enter` or leave the field. Undo and redo with `Ctrl+Z` / `Ctrl+Y` or the arrows in the toolbar.',
      '**+ Add** next to a section of the object list adds a device, link, network, relation, group or protocol. Fill in the highlighted fields.',
      '**Duplicate** copies an object under a new ID; **Delete** asks first and can be undone. Both are at the top of the Edit tab, and on the row under the pointer in the object list (also on the focused row, and on the selected row of a touch screen).',
    ],
    notes: ['The **Problems** tab lists every error and warning; click one to go to the object.'],
    figures: [
      ['edit', 'The Edit tab of a device: the header with Duplicate and Delete, then the fields in titled cards.'],
      ['quick-actions', 'Duplicate and Delete on the row under the pointer in the object list.'],
    ],
  },
  {
    id: 'connect',
    title: 'Create connections',
    steps: [
      '**Right-click** a device or an interface in the diagram. The endpoints it can be connected to are marked green; the others fade.',
      '**Right-click** a second, marked endpoint. A new link (physical view) or relation (logical view) opens in the Edit tab with both ends filled in.',
      'Fill in what is required, such as a relation\'s protocol, and press **Create link** / **Create relation**. **Cancel** or `Esc` discards it.',
    ],
    notes: ['From the keyboard: select a device or an interface, press `C`, pick the second endpoint in the bar over the diagram and press `Enter`.'],
    figures: [['connect', 'A connection being drawn in the physical view: compatible ports are marked green.']],
  },
  {
    id: 'arrange',
    title: 'Use Auto-arrange',
    steps: [
      '**Auto-arrange** in the toolbar lays out the whole model in the view on screen: **Default** (`A`), **Compact** (less empty space) or **Spacious** (more room for labels). The other view is not changed.',
      'The option the view is arranged with is highlighted. If you moved objects by hand, NetAtlas asks before replacing their positions; `Ctrl+Z` undoes the arrangement.',
      'Drag a device or network to move it. Its position is saved in the model, except in a filtered view.',
    ],
    figures: [['toolbar-groups', 'The View, Auto-arrange and Filters groups of the toolbar.']],
  },
];

const SHORTCUTS: Array<[string, string]> = [
  ['P / L', 'Physical / Logical view'],
  ['/', 'Find in diagram'],
  ['Ctrl+S / Ctrl+Shift+S', 'Save model / Save model as'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
  ['E', 'Edit tab'],
  ['C', 'Connect the selected object'],
  ['A', 'Auto-arrange: Default'],
  ['+ / − / 0', 'Zoom in / out / fit'],
  ['Esc', 'Clear the selection, cancel, close'],
];

/** "**bold** and `key`" as text nodes, <b> and <kbd> elements. */
function rich(doc: Document, text: string): Array<Node | string> {
  const out: Array<Node | string> = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*/g;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push(m[1] !== undefined ? el(doc, 'b', {}, [m[1]]) : m[2] !== undefined ? el(doc, 'kbd', {}, [m[2]]) : el(doc, 'i', {}, [m[3]]));
    at = re.lastIndex;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function figure(doc: Document, name: string, caption: string): HTMLElement | null {
  const img = MANUAL_IMAGES[name];
  if (!img) return null;
  return el(doc, 'figure', { class: 'man-fig' }, [
    el(doc, 'img', { src: img.src, width: String(img.width), height: String(img.height), alt: caption, loading: 'lazy', decoding: 'async' }),
    el(doc, 'figcaption', {}, [caption]),
  ]);
}

/**
 * The body of Help → User Manual: a list of the sections (buttons that
 * scroll to them, so the page's address never changes) and the sections.
 */
export function manualBody(doc: Document): HTMLElement {
  const wrap = el(doc, 'div', { class: 'manual', tabindex: '0', role: 'region', 'aria-label': 'User manual' });
  wrap.appendChild(el(doc, 'p', { class: 'man-lead' }, ['NetAtlas draws and edits network architecture diagrams from a YAML model, entirely in this browser window. These are the basic tasks.']));
  const toc = el(doc, 'nav', { class: 'man-toc', 'aria-label': 'Sections of the manual' });
  const list = el(doc, 'ol');
  toc.appendChild(list);
  wrap.appendChild(toc);
  for (const s of MANUAL.concat([{ id: 'keys', title: 'Keyboard shortcuts' }])) {
    const b = el(doc, 'button', { type: 'button', class: 'man-link', 'data-man-goto': 'man-' + s.id }, [s.title]);
    list.appendChild(el(doc, 'li', {}, [b]));
  }
  for (const s of MANUAL) {
    const sec = el(doc, 'section', { class: 'man-sec', id: 'man-' + s.id, 'aria-labelledby': 'man-h-' + s.id });
    sec.appendChild(el(doc, 'h3', { id: 'man-h-' + s.id, tabindex: '-1' }, [s.title]));
    if (s.intro) sec.appendChild(el(doc, 'p', {}, rich(doc, s.intro)));
    if (s.steps) sec.appendChild(el(doc, 'ol', { class: 'man-steps' }, s.steps.map((t) => el(doc, 'li', {}, rich(doc, t)))));
    for (const n of s.notes || []) sec.appendChild(el(doc, 'p', { class: 'man-note' }, rich(doc, n)));
    const figs = (s.figures || []).map(([name, cap]) => figure(doc, name, cap)).filter((f): f is HTMLElement => !!f);
    if (figs.length) sec.appendChild(el(doc, 'div', { class: 'man-figs' + (figs.length > 1 ? ' two' : '') }, figs));
    wrap.appendChild(sec);
  }
  const keys = el(doc, 'section', { class: 'man-sec', id: 'man-keys', 'aria-labelledby': 'man-h-keys' });
  keys.appendChild(el(doc, 'h3', { id: 'man-h-keys', tabindex: '-1' }, ['Keyboard shortcuts']));
  keys.appendChild(el(doc, 'p', { class: 'man-note' }, ['They work while the focus is not in a text field.']));
  keys.appendChild(
    el(doc, 'table', { class: 'man-keys' }, [
      el(
        doc,
        'tbody',
        {},
        SHORTCUTS.map(([k, what]) => el(doc, 'tr', {}, [el(doc, 'th', { scope: 'row' }, k.split(' / ').flatMap((x, i) => (i ? [' / ', el(doc, 'kbd', {}, [x])] : [el(doc, 'kbd', {}, [x])]))), el(doc, 'td', {}, [what])])),
      ),
    ]),
  );
  wrap.appendChild(keys);
  wrap.addEventListener('click', (e) => {
    const b = (e.target as Element).closest('[data-man-goto]');
    if (!b) return;
    const target = doc.getElementById(b.getAttribute('data-man-goto') || '');
    const h = target ? (target.querySelector('h3') as HTMLElement | null) : null;
    if (!target || !h) return;
    target.scrollIntoView({ block: 'start' });
    h.focus({ preventScroll: true });
  });
  return wrap;
}

/** The SPDX identifier and name of the license (as in package.json and LICENSE). */
export const LICENSE_ID = 'Apache-2.0';
export const LICENSE_NAME = 'Apache License, Version 2.0';

/** The body of Help → License: the license named, and its full text (embedded) one click away. */
export function licenseBody(doc: Document): HTMLElement {
  const text = el(doc, 'pre', { class: 'license-text', tabindex: '0', 'aria-label': 'Full text of the ' + LICENSE_NAME }, [LICENSE_TEXT]);
  return el(doc, 'div', { class: 'license' }, [
    el(doc, 'p', {}, ['NetAtlas is licensed under the ', el(doc, 'b', {}, [LICENSE_NAME]), ` (SPDX: ${LICENSE_ID}).`]),
    el(doc, 'p', {}, ['You may use, copy, modify and distribute it under the terms of that license. It is distributed on an “AS IS” basis, without warranties or conditions of any kind.']),
    el(doc, 'details', { class: 'license-full' }, [
      el(doc, 'summary', {}, ['Full license text']),
      el(doc, 'p', { class: 'muted small' }, ['Included in this file, so it is available offline. It is the LICENSE file of the NetAtlas source.']),
      text,
    ]),
  ]);
}
