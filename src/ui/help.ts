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
      '**Export → Export view as… → PNG** or **SVG** saves the view on screen as a picture: the whole diagram, with its legend and networks overview, in the theme you see (Light or Dark). The picture looks the same in any viewer, whatever that viewer\'s own light or dark setting.',
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
      'Every address is written in the diagram. A device\'s box lists its interfaces, each with its name and then its addresses (IPv4, then IPv6), VLAN, VRF, MAC address and tunnel ends. Networks show their prefix, cables their cable ID, and addresses kept in attributes (such as a VRRP virtual address) are written next to their object.',
      'Every relation starts at the **port** of the interface it names: a solid bar on the side of the device box, beside that interface\'s row, with the interface\'s name next to it (for a tunnel also its source, after `src:`). A relation that names only the device starts at the hollow port beside the device\'s name. In the physical view a cable ends at the port it is plugged into, and the member ports of a LAG sit in a bracket named by the LAG.',
      'Point at an interface, a relation or a cable to see what belongs together: the interface\'s row, its port and every relation and cable attached to it are outlined. Selecting a relation or cable highlights the interfaces at both of its ends.',
    ],
    notes: ['If moving objects by hand makes labels or boxes overlap, a note over the diagram says so; **Auto-arrange** places everything without overlaps again.'],
    figures: [
      ['physical', 'The physical view. Toolbar at the top, the object list (Objects) on the left, diagram in the middle, panels (Edit, Details, Legend …) on the right.'],
      ['logical', 'Part of the logical view (metro ring example): routers with their loopbacks, and the iBGP, LDP and RSVP-TE relations between them.'],
      ['addresses', 'A router in the logical view (addressing example): each interface with its addresses, VLAN, VRF and tunnel ends.'],
      ['ports', 'The branch router of the long-labels example: GRE and OSPF leave from the port beside Tunnel10, the relations bound to the router as a whole from the hollow port beside its name.'],
    ],
  },
  {
    id: 'theme',
    title: 'Choose a light or dark theme',
    steps: [
      'NetAtlas opens in the **Dark** theme. The theme switch at the right end of the toolbar toggles between **Dark** and **Light** (also with `Enter` or `Space`).',
      'Its tooltip says which theme is in effect and what a press does. The whole application and the diagram change at once; your selection, zoom and layout stay.',
      'NetAtlas remembers your choice in this browser. It is never stored in the model file.',
    ],
    figures: [['theme', 'The theme switch with its tooltip, in the dark theme (the default).']],
  },
  {
    id: 'find',
    title: 'Find and filter objects',
    steps: [
      '**Find → Find in diagram…** (`/`) opens a search bar over the diagram. Type an ID, label, address, prefix, protocol, a route\'s prefix or next hop, or a VLAN (`vlan 20` finds the cables carrying it); press `Enter` or click a match to select it. `Esc` closes the bar.',
      '**Find → Filter object list…** shows a filter box above the object list on the left. It narrows the list only; the diagram is not changed. `Esc` or **×** clears it.',
      'The **Filters** group in the toolbar chooses what the diagram shows: **Devices ▾** for some devices only, and switches for labels, groups, networks, routes, endpoints and servers. Nothing is deleted, and positions in a filtered view are temporary.',
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
      'Click an object in the diagram or in the object list (**Objects**, on the left). The **Edit** tab on the right opens it; **Details** gives a read-only summary.',
      'Type in a field. A change applies when you press `Enter` or leave the field. Undo and redo with `Ctrl+Z` / `Ctrl+Y` or the arrows in the toolbar.',
      '**+ Add** next to a section of the object list adds a device, link, network, relation, group or protocol. Whatever you add (also an interface, a route, an address …) is selected, scrolled into view, and the cursor is in its first field with the proposed text selected: just type. `Ctrl+Z` right away takes it back.',
      '**Duplicate** copies an object under a new ID; **Delete** asks first and can be undone. Both are at the top of the Edit tab, and on the row under the pointer in the object list (also on the focused row, and on the selected row of a touch screen).',
    ],
    notes: [
      'The Edit tab marks what is selected with **▸ Selected** and a bar on the left: the object\'s header, the selected interface\'s card, or, when you clicked a line of the diagram such as an address, VLAN or VRF, that very field. It scrolls there if needed.',
      'The **Problems** tab lists every error and warning; click one to go to the object.',
      'Drag the grip on the side panel\'s left edge to make it wider or narrower (double-click resets it), or focus it with `Tab` and use `←` and `→`. The width is remembered in this browser.',
    ],
    figures: [
      ['edit', 'The Edit tab of a device: the header with Duplicate and Delete, then the fields in titled cards.'],
      ['quick-actions', 'Duplicate and Delete on the row under the pointer in the object list.'],
      ['edit-mark', 'An address clicked in the diagram: the Edit tab marks that address of the interface.'],
    ],
  },
  {
    id: 'routes',
    title: 'Static routes and VLAN tagging',
    steps: [
      'Select a router (or a host) and open the **Edit** tab. Under **Static routes**, **+ Route** adds a route: enter the **Destination prefix** and the **Next-hop address**, or pick an **Exit interface**, or switch **Blackhole** on. A higher **Administrative distance** makes a floating backup; **⧉** duplicates a route.',
      'In the **Logical** view each device shows its routes as a route table in its box, one line per route. A dotted line with an arrow leads from a route to the interface its next hop belongs to. The **Routes** switch in **Filters** hides them; nothing moves.',
      'Select a link: each end has a **Mode** (**Access** or **Trunk**), an **Untagged VLAN** (a trunk\'s native VLAN) and, for a trunk, **Tagged VLANs** such as `10, 20, 100-199`. The **Physical** view writes the tagging under each port\'s name: `U 99 · T 10,20`.',
    ],
    notes: [
      'NetAtlas checks the routes and the tagging: a next hop that isn\'t connected or doesn\'t resolve, an exit interface that can\'t forward, VLANs that differ between the two ends of a cable … Each finding is in the **Problems** tab with its check, and at its field in the Edit tab.',
    ],
    figures: [
      ['routes', 'The branch router in the logical view: its route tables (default table and the guest VRF) and the dotted lines to the next hops.'],
      ['tagging', 'A trunk between a router and an access switch in the physical view: VLAN 99 untagged, VLANs 10, 20 and 30 tagged at both ends.'],
    ],
  },
  {
    id: 'checks',
    title: 'Find inconsistencies',
    steps: [
      'Open the **Problems** tab. **The file** lists what breaks the format; **Consistency checks** lists where the network the model describes contradicts itself: MTUs, speeds or duplex that differ across a cable, addresses in different subnets, a duplicate router ID, OSPF or BGP parameters that disagree, a tunnel that doesn\'t fit its underlay …',
      'Each finding shows its **severity**, its **check id** and the objects it concerns. Click a finding to open its object in the Edit tab, where the message is at the field; click an object to select it. The **Errors**, **Warnings** and **Info** buttons narrow the list.',
      'To switch a check off or change its severity for this model, press **Change in the model settings** (or **Edit model settings** in the Edit tab) and choose under **Consistency checks**. The choice is written to the model\'s `checks:` section.',
    ],
    notes: [
      'A check only compares what the model writes down: an interface\'s **MTU**, a link end\'s port **speed** and **duplex**, a device\'s **router ID** and **AS number**, protocol parameters in a relation\'s attributes. Where a value is missing, nothing is assumed. The example **consistency-checks.yaml** has a mistake for every check.',
    ],
    figures: [
      ['problems', 'The Problems tab of the consistency-checks example: the file has no problems; the findings with their check id, the severity filter and the check the model changes.'],
      ['checks', 'Model settings → Consistency checks: each check with its default severity and what this model makes of it.'],
    ],
  },
  {
    id: 'palette',
    title: 'Use the command palette',
    steps: [
      'Press `Ctrl+K` (`Cmd+K` on a Mac), or choose **Find → Command palette…**. A search field opens over the window.',
      'Type a few letters of what you want: a command (**save**, **logical view**, **addressing**, **focus** …) or an object of the model (a device, interface, cable, network, relation, route or location, by name, id or address). The letters need not be next to each other: `adrs ovr` finds *Addressing overview*.',
      'Move with `↑` and `↓`, press `Enter` to run the command or select the object in the diagram, `Esc` to close. Each command shows its shortcut; one that can\'t run now is greyed out with the reason.',
    ],
    notes: ['With nothing typed, the entries you used last come first.'],
    figures: [['palette', 'The command palette: “focus” typed, with Focus…, the hop commands and Exit focus; an unavailable one says why.']],
  },
  {
    id: 'focus',
    title: 'Focus on a part of the network',
    steps: [
      'Select a device, interface, cable, network, relation or location, then press `Shift+F` or choose **Analyze → Focus…**. The **Focus** window opens with the object and focuses on it at once. (The **◎ Focus** button under the diagram focuses without the window.)',
      'The diagram shows only that object and what is one hop away: along cables in the **Physical** view, along relations in the **Logical** view. Choose 1, 2 or 3 **hops** in the window, or **−** and **+** in the banner across the top.',
      'Press **Exit focus** (in the window or the banner) or `Esc` in the diagram to see the complete diagram again, exactly as before. Closing the window keeps the focus on.',
    ],
    notes: ['Focus works with the other filters (Devices, Endpoints, Servers …). Positions you change while focused are temporary and not saved; nothing in the model changes. An export shows what is on screen, with a *Focus* note.'],
    figures: [['focus', 'Focus on the firewall in the physical view, one hop: the banner with the hops and Exit focus, and the Focus window.']],
  },
  {
    id: 'protocols',
    title: 'Run routing protocols on a device',
    steps: [
      'Select a router, switch, firewall, load balancer, proxy or gateway. Its **Protocols** card lists what it runs.',
      'If its relations use a protocol it doesn’t run, a suggestion such as **+ Enable OSPF · used by ospf-13** enables it with one click. Otherwise choose one under **Enable a protocol…**.',
      'Fill in what the protocol requires: BGP’s **Local AS number**, OSPF’s **Router ID** (a loopback such as `lo0`, or an IPv4 address), IS-IS’s NET. Until then they are errors, here and in Problems.',
      'For VRRP or HSRP, open the interface and press **+ VRRP group**: its group number, virtual IP and priority.',
      '**Disable** removes a protocol and its values, after listing them; Ctrl+Z brings them back.',
    ],
    notes: ['The router ID and the AS number are written in the device’s box only while a protocol uses them. Nothing is filled in for you.'],
    figures: [['protocols', 'r3’s Protocols card: the suggestion to enable OSPF, BGP with its AS number, and Enable a protocol.']],
  },
  {
    id: 'helpers',
    title: 'Fill in fields faster',
    steps: [
      'Under many fields of the Edit tab, small buttons offer values that fit: for an MTU *1500* or *9000 (jumbo)*, for a tunnel the MTU its underlay leaves room for; for a VLAN the next free ID; for a router ID the device’s loopbacks.',
      'Press one (or Tab to it and press Enter) to write that value. It is one step you can undo, and it is checked like anything you type.',
      'A MAC field has **Generate**: a random, locally administered address no other interface has, written like the model’s other MAC addresses.',
      'A VRF field lists the VRFs in use as you type: ↑ / ↓ to choose, Enter to take it, Esc to close. A name that differs only in upper and lower case from one in use is flagged.',
    ],
    notes: ['Nothing is filled in by itself: a helper only acts when you press it.'],
    figures: [['helpers', 'A tunnel interface: the MTU suggestions, among them its underlay’s MTU less the GRE and IPsec overhead, and Generate under the MAC field.']],
  },
  {
    id: 'windows',
    title: 'Work with the Analyze windows',
    steps: [
      'Every entry of **Analyze** (Addressing overview, Focus, Trace path, Single points of failure) opens a window over the diagram. The diagram and the side panel stay usable: click in the diagram to select while the window is open.',
      'Drag the title bar to move the window and the **◢** grip to resize it; **▾** folds it to its title bar, **Dock** puts it under the diagram. From the keyboard, the **⠿** button and the grip take the arrow keys (Shift: faster). Each window opens where you left it, at its size.',
      'Press `F6` to move the keyboard between the window and the rest of the page. **×** or `Esc` closes it, and the keyboard is back where it was. Opening another window replaces the one that is open.',
    ],
    notes: ['In a narrow window (or zoomed in strongly) the windows are docked at the bottom, full width, above the status bar; the diagram gets smaller and the page never scrolls.'],
  },
  {
    id: 'spof',
    title: 'Find single points of failure',
    steps: [
      'Choose **Analyze → Single points of failure…**. The window lists the cables, devices and LAGs whose failure alone would cut devices off from the rest or bring relations down: what it **cuts off**, the **relations down** and the **impact** (both added up), most impact first.',
      'Press a column header to sort by it, again to reverse. Type in **Filter** to keep the rows with those words. **Show in diagram** selects that cable, device or LAG.',
      '**Copy CSV**, **Save CSV**, **Copy text** and **Save text** give the rows as shown to a spreadsheet or a text.',
    ],
    notes: ['Each cable, device and LAG is failed alone, never two at once, and the failure follows the model: what runs `over` it, LAGs with their minimum links, VRRP groups failing over. Nothing in the model changes.'],
    figures: [['spof', 'The Single points of failure window for the enterprise WAN: the internet cloud and the uplinks first, with what each cuts off and the relations that go down.']],
  },
  {
    id: 'trace',
    title: 'Trace a path',
    steps: [
      'Press `T` or choose **Analyze → Trace path…**. The **Trace path** window opens; a selected device or interface is already in **From**.',
      'Fill in **To**: a device, an interface (`device:interface`) or an IP address. Tick **Trace the return path too** to see the way back as well, then press **Trace**.',
      'The path is marked in the diagram (thick outline; equal-cost alternatives dashed, the return path dotted) and listed in a table, a row per hop: the **device**, the interfaces **in** and **out**, the **addresses**, the **route or relation** used and the **encapsulation** (GRE over IPsec …), the cables under each row. Each alternative and the return path have their own section. If it can\'t get through, the window says where and why.',
      'Click a name in the table to select it. **Copy as text** copies the trace; **Exit trace**, `Esc` in the diagram or closing the window removes the path.',
    ],
    notes: ['The trace is computed from the routes and adjacencies in the model: an approximation, not a simulation of the protocols. ACLs, firewall policies and NAT are not considered. Nothing in the model changes.'],
    figures: [['trace', 'A path from the Munich branch to the syslog server: through the GRE-over-IPsec tunnel, the firewall and a core switch, with the equal-cost alternative dashed, and the Trace path window with its hop table.']],
  },
  {
    id: 'addressing',
    title: 'See the addressing',
    steps: [
      'Choose **Analyze → Addressing overview…** (or press `I`). It lists the networks of each VRF, the default table first, each network under the network that contains it.',
      'A row shows the **prefix**, **VLAN**, **name**, the **gateway or VIP**, how many addresses are **used** of the network\'s **size**, the **utilization** (a percentage for IPv4; for IPv6 the number of /64 subnets), the **next free** address and the **free ranges**. **▸ members** opens the device, interface, address, DNS name and DHCP flag of each member.',
      'Type in **Filter** to narrow the rows (prefix, name, VLAN, device, address …); press a column header to sort, again to reverse. Click a network, device or interface to select it in the diagram; the window stays open.',
      'Below the tables: **duplicate addresses**, **overlapping prefixes** and **addresses in no network**. **Copy CSV** and **Save CSV** give the table to a spreadsheet.',
    ],
    notes: [
      'When you add an address in the Edit tab, **Next free address** offers the lowest free address of a network of the interface\'s VRF, the networks on its cable first; **+ Add** adds it.',
    ],
    figures: [['addressing', 'The Addressing overview of the addressing example: the default table with nested networks, gateways and VIPs, use, utilization and free ranges, one network\'s members opened.']],
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
  ['I', 'Addressing overview'],
  ['Ctrl+K', 'Command palette (Cmd+K on a Mac)'],
  ['Shift+F', 'Focus window: focus on the selection (Esc exits)'],
  ['T', 'Trace path window (Esc in the diagram removes the path)'],
  ['F6', 'Between a tool window and the page'],
  ['Ctrl+K → enable', 'Enable a protocol on the selected device'],
  ['A', 'Auto-arrange: Default'],
  ['+ / − / 0', 'Zoom in / out / fit'],
  ['Esc', 'Clear the selection, cancel, close (a tool window too)'],
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
