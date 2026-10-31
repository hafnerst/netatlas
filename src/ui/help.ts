/**
 * Help → User Manual and Help → License: their content, built from text
 * nodes and elements only. The screenshots and the license text are embedded
 * in the page (generated/help-assets.ts), so both work without a network.
 */
import { el } from './dom';
import { LICENSE_TEXT, MANUAL_IMAGES } from '../generated/help-assets';
import { ANALYSIS_SUPPORT, supportAreas, supportCatalog } from '../model/support-catalog';
import { supportLabel } from '../model/support';

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
    notes: [
      'The same commands are in the **File** menu at any time. If the current model has unsaved changes, NetAtlas asks first. Files are read locally; nothing is uploaded.',
      'NetAtlas is this one HTML file: open `netatlas.html` (the built file, not `src/index.html`) in Chrome, Edge, Firefox or Safari. It needs no server, no installation and no network connection, so it also works on a computer without one.',
      '**File → Close model** returns to the start screen; with unsaved changes it offers to save first, to discard them or to cancel.',
    ],
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
    notes: [
      'A small dot on the file name in the status bar means that there are unsaved changes.',
      'Only Chrome, Edge and other Chromium-based browsers can write to a file you choose. In Firefox and Safari the copy is downloaded into the downloads folder and is not linked: *Save model* stays unavailable and the status bar says so. A model with validation errors lists them first; the button then reads **Download anyway**.',
      'Everything in the file survives opening, editing and saving: attributes no diagram shows, keys NetAtlas doesn’t know, comments, key order and quoting. Indentation becomes 2 spaces.',
    ],
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
      ['logical', 'Part of the logical view of a metro ring: routers with their loopbacks, and the iBGP, LDP and RSVP-TE relations between them.'],
      ['addresses', 'A router in the logical view: each interface with its addresses, VLAN, VRF and tunnel ends.'],
      ['ports', 'A branch router: GRE and OSPF leave from the port beside Tunnel10, the relations bound to the router as a whole from the hollow port beside its name.'],
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
      'The **Filters** group in the toolbar chooses what the diagram shows: **Devices ▾** for some devices only, **Device types ▾** for some types of device, and switches for labels, groups, networks and routes. Nothing is deleted, and positions in a filtered view are temporary.',
      '**Device types ▾** lists the types the model uses, each with its number of devices (a type the model does not use is left out); a Switch with Layer 2 and Layer 3 switches has both under it. Untick a type to hide its devices and what only they connect; the other devices stay where they are. **Select all** and **Clear** tick or untick every type; the button and the status bar say what is shown (*Device types: 3 of 8*).',
      'The two filters combine: the diagram shows the selected devices whose type is ticked. A device hidden by its type stays ticked in **Devices ▾**, marked *hidden: type Server off*; ticking its type again brings back exactly the view before. With every device and type shown again, the complete diagram returns with its saved positions.',
    ],
    figures: [
      ['find', 'Find in diagram: matches are listed as you type.'],
      ['filter-list', 'Filter object list: only the entries that contain the text stay listed.'],
      ['device-types', 'Device types ▾ for the example enterprise-campus.yaml: Layer 2 switches unticked under Switch, the other types shown, each with its number of devices.'],
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
    title: 'Static routes and port VLANs',
    steps: [
      'Select a router (or a host) and open the **Edit** tab. Under **Static routes**, **+ Route** adds a route: enter the **Destination prefix** and the **Next-hop address**, or pick an **Exit interface**, or switch **Blackhole** on. A higher **Administrative distance** makes a floating backup; **⧉** duplicates a route.',
      'In the **Logical** view each device shows its routes as a route table in its box, one line per route. A dotted line with an arrow leads from a route to the interface its next hop belongs to. The **Routes** switch in **Filters** hides them; nothing moves.',
      'Select a port: its **VLANs** say what it carries. One VLAN makes an **access port**, several a **trunk**. Type a VLAN or a range (`30-39`) and press `Enter` or a comma; while you type, the model\'s VLANs are offered with their names (`↑` `↓`, `Enter`). `Backspace` in the empty field removes the last one, **×** any one.',
      'A trunk has a **Native VLAN** (untagged; *None*: every VLAN tagged). A Layer 3 switch\'s port can be a **Routed port** instead. The mode is written beside the field: *Access · VLAN 10*, *Trunk · 10, 20 (native 10)*, *Routed*.',
      'A switch port needs its VLANs: without them it is an error at the field and in **Problems**. **Same as …** copies a neighbouring port\'s VLANs, **VLANs of the connected port** the far end\'s. **Assign VLANs to ports…** on a device gives a range of ports the same VLANs in one step.',
      'A **VLAN interface** (`Vlan10`) is bound to every port of its VLAN by itself: its **Bridge ports** are listed, read-only. On a router, a port without VLANs is routed; its subinterfaces (`ge-0/0/2.10`) tag their VLANs on it.',
      'The **Physical** view writes each port\'s VLANs under its name: `A 10` (access), `T 10,20 · N 99` (trunk, native 99); trunks have a thick frame.',
    ],
    notes: [
      'NetAtlas checks the routes and the VLANs: a next hop that isn\'t connected or doesn\'t resolve, an exit interface that can\'t forward, access ports in different VLANs, trunks with different lists, a native VLAN mismatch … Each finding is in the **Problems** tab with its check, and at its field in the Edit tab.',
      'In the simulation, a VLAN a port doesn\'t allow is dropped, and untagged frames between ports whose native VLANs differ leak into the other VLAN; the log says which.',
    ],
    figures: [
      ['routes', 'The branch router in the logical view: its route tables (default table and the guest VRF) and the dotted lines to the next hops.'],
      ['port-vlans', 'A trunk port in the Edit tab: its VLANs as chips, the field to add more, its native VLAN and the badge Trunk · 10, 20, 99 (native 99).'],
      ['tagging', 'A router-on-a-stick in the physical view: the router\'s routed port tags its subinterfaces\' VLANs (R · T 10,20,30), the switch\'s trunk has VLAN 99 native (T 10,20,30,99 · N 99).'],
    ],
  },
  {
    id: 'checks',
    title: 'Find inconsistencies',
    steps: [
      'Open the **Problems** tab. **The file** lists what breaks the format; **Consistency checks** lists where the network the model describes contradicts itself: MTUs, speeds or duplex that differ across a cable, addresses in different subnets, a duplicate router ID, OSPF or BGP parameters that disagree, a tunnel that doesn\'t fit its underlay …',
      'Each finding shows its **severity**, its **check id** and the objects it concerns. Click a finding to open its object in the Edit tab, where the message is at the field; click an object to select it. The **Errors**, **Warnings** and **Info** buttons narrow the list.',
      'To switch a check off or change its severity for this model, press **Change in the model settings** (or **Edit model settings** in the Edit tab) and choose under **Consistency checks**. The choice is written to the model\'s `checks:` section.',
      '**Analyze → Design review: findings** shows the same findings by kind (contradictory configuration, missing information, potential risk), each with its possible consequence, its evidence and a next step. Nothing is fixed for you.',
    ],
    notes: [
      'A check only compares what the model writes down: an interface\'s **MTU**, a link end\'s port **speed** and **duplex**, a device\'s **router ID** and **AS number**, protocol parameters in a relation\'s attributes. Where a value is missing, nothing is assumed.',
    ],
    figures: [
      ['problems', 'The Problems tab of a model with a deliberate mistake for every check: the file has no problems; the findings with their check id, the severity filter and the check the model changes.'],
      ['checks', 'Model settings → Consistency checks: each check with its default severity and what this model makes of it.'],
    ],
  },
  {
    id: 'palette',
    title: 'Use the command palette',
    steps: [
      'Press `Ctrl+K` (`Cmd+K` on a Mac), or choose **Find → Command palette…**. A search field opens over the window.',
      'Type a few letters of what you want: a command (**save**, **logical view**, **addressing**, **focus** …) or an object of the model (a device, interface, cable, network, relation, route or location, by name, id or address). The letters need not be next to each other: `adrsng` finds *Addressing*.',
      'Move with `↑` and `↓`, press `Enter` to run the command or select the object in the diagram, `Esc` to close. Each command shows its shortcut; one that can\'t run now is greyed out with the reason.',
    ],
    notes: ['With nothing typed, the entries you used last come first.'],
    figures: [['palette', 'The command palette: “focus” typed, with Focus…, the hop commands and Exit focus; an unavailable one says why.']],
  },
  {
    id: 'focus',
    title: 'Focus on a part of the network',
    steps: [
      'Select a device, interface, cable, network, relation or location, then press `Shift+F` or choose **Analyze → Focus…**: the **Focus** window opens beside the diagram, in whichever workspace you are, and focuses on the object at once. (The **◎ Focus** button under the diagram focuses without the window.)',
      'The diagram shows only that object and what is one hop away: along cables in the **Physical** view, along relations in the **Logical** view. Choose 1, 2 or 3 **hops** in the window, or **−** and **+** in the banner across the top.',
      'Or show what the selection takes part in, when that applies: its **VLAN**, its **VRF**, its **Application and service dependencies**, its **Multicast group**, or its **PTP timing domain** / **NTP time sources**. These show configured structure, not observed traffic: being shown together is no proof that devices reach each other.',
      'Press **Exit focus** (in the window or the banner) or `Esc` in the diagram to see the complete diagram again, exactly as before.',
    ],
    notes: ['Focus is a view aid, not an analysis: it changes what is drawn, never what an analysis evaluates or what a simulation runs. A result of Analyze can use it too (**Show only relevant objects**). Positions you change while focused are temporary and not saved; an export shows what is on screen, with a *Focus* note.'],
    figures: [['focus', 'Focus on the firewall in the physical view, one hop: the banner with the hops and Exit focus, and the Focus window.']],
  },
  {
    id: 'protocols',
    title: 'Run routing protocols on a device',
    steps: [
      'Select a router, Layer 3 switch, firewall, load balancer, proxy or gateway. Its **Protocols** card lists what it runs.',
      'If its relations use a protocol it doesn’t run, a suggestion such as **+ Enable OSPF · used by ospf-13** enables it with one click. Otherwise choose one under **Enable a protocol…**.',
      'Fill in what the protocol requires: BGP’s **Local AS number**, OSPF’s **Router ID** (a loopback such as `lo0`, or an IPv4 address), IS-IS’s NET. Until then they are errors, here and in Problems.',
      'For VRRP or HSRP, open the interface and press **+ VRRP group**: its group number, virtual IP and priority.',
      '**Disable** removes a protocol and its values, after listing them; Ctrl+Z brings them back.',
      '**Routing policy** (a collapsed line on BGP, OSPF, IS-IS, EIGRP and RIP) says what the device advertises: by default every connected network, else the prefixes under **Advertise**; a **Default route** (always, or only while it has one); what it **Redistributes**; and the ordered **Import** and **Export** rules (**+ permit rule**, **+ deny rule**; action, prefix, peer, the lengths and BGP’s local preference or prepend under **More**). The first matching rule decides; a route no rule matches is denied. OSPF and IS-IS flood what they learn: they have **Import** rules only, which decide what the router installs.',
    ],
    notes: ['The router ID and the AS number are written in the device’s box only while a protocol uses them. Nothing is filled in for you. Communication and the simulation apply the routing policy alike; a hop’s **Why?** names a route’s origin, AS path, local preference and the rules on its way.', 'A router, Layer 3 switch or firewall has a **Network policy** card too, one collapsed line until opened: **Add a policy…** starts one with the default action you choose; its **Rules** (first match wins: action, source, destination, protocol, port; the name, source port, interfaces and zones under **More**) filter what it forwards, statefully on a firewall unless **Stateful** says otherwise. IP protocols without ports (GRE, ESP …) are decided by rules with protocol *any* (else the default action) and tracked by their address pair and protocol number, so one protocol’s session never lets another through; an ICMP error about a session’s packet (Fragmentation Needed, Packet Too Big …) belongs to that session. Communication, Design review and the simulation decide by the same rules and name the rule that decided. Without a policy a firewall keeps its relations and allow list.'],
    figures: [['protocols', 'r3’s Protocols card: the suggestion to enable OSPF, BGP with its AS number, and Enable a protocol.']],
  },
  {
    id: 'switches',
    title: 'Make a switch Layer 2 or Layer 3',
    steps: [
      'Select a switch. In its **Identity** card, **Supports Layer 3** (*Routing, routing protocols, and gateways*) says whether it routes. A new switch is a **Layer 2 switch**: it forwards frames, may have one management interface with an address and static routes (for example a default gateway for management), and runs no routing protocols.',
      'On a Layer 2 switch, **Enable a protocol…** lists the routing protocols disabled, under *Requires Layer 3*, with the reason; nothing of Layer 3 is suggested, and a relation that needs Layer 3 does not offer the switch as an endpoint (it says why).',
      'Tick **Supports Layer 3** to make it a **Layer 3 switch**: protocols, a router ID, addresses on several VLAN interfaces (it routes between them), VRRP or HSRP groups, DHCP relays, tunnels and VRFs.',
      'Untick it on a configured Layer 3 switch: NetAtlas lists what is removed with it (and the relations that need routing, which stay and are reported) and asks first. It is one step you can undo.',
    ],
    notes: ['The diagram marks every switch with **L2** or **L3** on its icon (a Layer 3 switch also has its own icon), in both views and in exports; the legend explains it, and the object list shows it beside the name.'],
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
    title: 'Work in the Analyze workspace',
    steps: [
      'Every entry of **Analyze** opens the **Analyze** workspace, in place of the Objects list and the Inspector. It is organized by the question you ask: **Overview** (where to start), **Communication** (can this communicate, and why not), **Resilience** (what stops working when something fails; single-component failures, outage impact, capacity), **Design review** (the consistency findings, and the requirements saved with the model) and **Addressing** (conflicts, overlaps, allocation). The buttons at the top of the left panel switch between them (the arrow keys move); each keeps its question, its result and its selection.',
      'Every task uses the panels the same way: on the **left** the **Question** (what, from where to where, on what, with what options; one primary action), at the **bottom** the **Answer and results** (the answer first, what was evaluated, what limits it, then the tables), on the **right** the **Evidence** of what you select in the results: what it is, the result’s context, the explanation, the evidence and decisions, the objects it concerns and what to inspect next. An editor shown there says it is one: its own title, **Save changes** and **Cancel**.',
      'Selecting a result item (a row, a layer, a hop, an issue) shows its evidence; nothing is computed again and no simulated clock moves. **Close evidence** or `Esc` lets it go, and the keyboard returns to where it was chosen from. Following a result into another task (a dependency into Communication, a requirement’s communication) offers **← Back to …**, which returns to that result and item.',
      'Under **Relevant objects**: **Locate in diagram**, **Fit relevant objects**, **Show only relevant objects** (a display filter: the analysis keeps its scope) and **Restore previous view**. The layout of the panels is your choice: **Balanced**, **Diagram-focused** or **Results-focused** (in the results’ head).',
      '`F6` / `Shift+F6` move the keyboard between the left panel, the diagram, the right panel and the results. `Esc` is layered: an editor is cancelled, then the evidence let go; in a panel’s field it never leaves the workspace; in the diagram it ends a path or a focus first, then leaves Analyze. Entering or leaving changes nothing in the model.',
    ],
    notes: [
      'From a running simulation, Analyze pauses it and keeps it: its analyses read a frozen snapshot of it (or the configured model, as you choose under **Next computation**), never the live state. **Exit Analyze** returns to the simulation and resumes it. From Experiments, a running experiment goes on.',
      'Loading another model clears what belonged to the old one: its results, selections, recent and pinned results and pending work; nothing of it is shown for the new model. An edit of the same model keeps a result, marked **Outdated** (Refresh computes it again).',
      'In a narrow window (or zoomed in strongly) Analyze shows one working surface at a time — **Question**, **Results**, **Evidence**, **Diagram** — under tabs; the page never scrolls sideways. Asking a question shows its results, selecting an item its evidence.',
    ],
  },
  {
    id: 'overview',
    title: 'Start from the overview: dependencies and recent results',
    steps: [
      'Choose **Analyze → Overview**: the questions Analyze answers, one per task, and what is known about this model — the saved requirements and whether (and how) they were evaluated, the consistency findings, invalid input, results outdated by an edit, the interfaces addressed at run time (questions about them need a snapshot). Each count says its context and state: not evaluated is not satisfied. Opening it computes nothing; there is no overall score.',
      '**From the selection** offers what applies to the selected object: **Diagnose its communication**, **Check communication from it**, **Explore its dependencies**, **What if it fails**, or a network’s addressing.',
      '**Explore its dependencies** lists, for that component, what it **depends on** and what it is **used by** (the configured dependencies, and virtualization hosts and guests), and — when you press **Evaluate its failure** — what its **failure affects**. Each entry’s evidence leads into Communication, Resilience or a contextual focus. Selecting another object does not replace the component explored. Only what the model configures is listed: no production dependency is inferred, no business importance assumed.',
      '**Recent and pinned results** keeps the last 12 results of this session and up to 8 pinned ones: the question, its context, the model’s fingerprint, when it was computed, and whether it is outdated or evidence-limited. **Reopen** shows a result as it was computed, with its selection (outdated when the model changed since; Refresh there computes it again); **Pin** keeps it; **Save record** saves it as text. Nothing of it is saved with the model, and a pinned result does not keep a simulation’s records available.',
    ],
  },
  {
    id: 'results',
    title: 'Read an analysis result',
    steps: [
      'A verdict is a mark and words (never colour alone): **✓ Satisfied** or **Reachable within scope** (the model establishes it), **✕ Violated** or **Blocked** (something modeled prevents it), **◐ Partially** (equal-cost paths end differently), **↗ Beyond modeled scope**, **? Indeterminate** (information is missing, such as an address only DHCP assigns at runtime) and **– Unsupported**. Only the first is a positive conclusion, and only within the model.',
      'The **context** says what the result shown was computed on — the **Configured model** or a **Frozen simulation snapshot at t = …**, with a **Hypothetical failure condition** or a **Recorded runtime exchange** on top when there is one —, its **scope** and when it was computed. While a simulation runs, **Next computation** chooses what the next question reads; the result on screen keeps its own context until you ask again.',
      'What limits a result is said where it is: a question changed after it (✎: the answer is to the question before), **Outdated** after an edit (**Refresh**), **Incomplete** coverage (a limit, or **Stop**), **Evidence-limited** (records no longer kept). A display filter never changes the scope.',
      '**Assumptions and limits** under each result says what the analysis assumes and leaves out. Copies and saved texts carry the context, the coverage, the version and the assumptions.',
    ],
    notes: ['A snapshot freezes the simulation’s state at that moment: its DHCP leases, SLAAC and DHCPv6 addresses, what is up and what was learned. A task that can’t evaluate a snapshot correctly (a hypothetical failure would blend two states) says so and reads the configured model.'],
  },
  {
    id: 'spof',
    title: 'What stops working when something fails',
    steps: [
      '**Resilience: single-component failures**: every cable, device and LAG failing alone (and for guests their host, a virtual switch with one uplink, a passthrough port). Each row says, apart: the saved **requirements no longer satisfied**, the **configured dependencies unavailable** (application peers, MQTT brokers, DNS, DHCP, timing sources, syslog, AAA), the **devices disconnected**, the **relations unavailable**, and its **status**. No measure is added to another: none is a business criticality. Values are explicit: a count, **None affected**, **Checking**, **Not evaluated**, **Indeterminate**. The check runs candidate by candidate while you work; **Stop** ends it and the coverage says how far it got.',
      'Sort by a column header, filter by words; a selected row stays selected while the check goes on, and its evidence lists what it affects. **Show** selects it in the diagram; **Investigate** prepares the same component in Outage impact (add more to combine them).',
      '**Resilience: outage impact** answers *what stops working, what remains available and what becomes uncertain if these components become unavailable?* Choose components to make unavailable; the modeled consequences are compared with the architecture without this outage; nothing in the model is changed. Useful to check whether another uplink preserves connectivity, to examine a maintenance outage, the loss of a broker or resolver, or two components unavailable together. Single-component failures scans every component alone; outage impact answers for the ones you choose.',
      'Find components in **Add component** by name, ID, type or endpoint (`↑`/`↓` choose, `Enter` adds; a partial name is never picked for you), or with **Analyze outage impact…** on the selection (the Overview, the command palette): it is prepared, never analyzed at once, and an existing condition is kept unless you choose **Add to the condition** or **Start a new condition with it**. Devices, cables, interfaces and relations can be chosen; a group adds its devices (its membership, never what is drawn near it). A network or an application is not made unavailable on its own: choose its device, cable or interface.',
      'Under **Assume unavailable** the condition is shown before anything runs: each component (removable), how many you chose, how many came from a saved set, how the analysis will propagate it (a device takes its interfaces and cables down — results, not further choices), and what is compared. More than 64 components, or one no longer in the model, is refused with why; nothing is cut off silently. **Also check** adds device pairs in a scope (bounded, with **Stop** and the coverage); it never starts on its own.',
      '**Analyze impact** answers in the results: the outage, then, compared with the same configured architecture without it, the requirements no longer satisfied (or **No saved requirements were available to evaluate**), the configured dependencies that become unavailable or **remain available through an alternative**, what cannot be determined, the further objects that go down as a consequence, capacity and device pairs. Without any change it says **No additional modeled effect found within the checks performed** — never that the outage has no effect. Issues that existed before the outage are listed apart. The groups below tell **Unavailable by assumption** from **Propagated effects**; select an item for its state without and under the outage, and why. Communication checks the architecture without the outage: its actions say so. **Prepare an experiment…** adds an experiment that fails these components (one undo step) for what happens over time.',
      'A **saved failure set** (a failure domain: a named set of components assumed to become unavailable together — a rack, a room, shared power, a conduit, a provider) is an optional shortcut: **Add saved failure set…** copies its components into the condition, each marked as coming from it; removing one there does not change the saved set. **Define failure domains…** opens their editor: **Add failure domain**, a name, its kind and its members — a model edit with undo. A group of the diagram is no failure domain unless one names it; deleting one names the requirements that use it.',
      '**Resilience: capacity**: the traffic the model states (demands, applications with an interval) against the speeds it states, with no failure or under a failure condition: per demand the resource and direction that decide, the bounds of an equal split over equal-cost paths and of all on one path, what is missing (a speed not written), and what changes under the condition (overloaded although still carried, no longer carried, now depending on the distribution).',
    ],
    notes: ['An outage is a hypothetical condition on the configured model, not a probability or a production availability; no protocol convergence, recovery time or transient loss is claimed, and capacity is no measured throughput or hardware performance. Losing a DHCP server stops new assignments and renewals; leases already given last until they end. The failure follows the model: what runs `over` it, LAGs with their minimum links, VRRP groups failing over. Nothing in the model changes. The tables can be copied or saved as CSV or text, with the context and coverage.'],
    figures: [['spof', 'Resilience for the enterprise WAN: single-component failures with their separate measures, and the evidence of the firewall failing alone.']],
  },
  {
    id: 'saved-views',
    title: 'Save and open a view',
    steps: [
      'Choose **Find → Saved views…**. The window says what is on screen (the diagram, a focus, the filters, the zoom).',
      'Type a name and press **Save current view** (or `Enter`): the view is written to the model (one undo step), with the diagram, the focus, the devices and device types shown, the protocols drawn, the display options and the zoom.',
      '**Open** shows a saved view again. It changes what is drawn only: the model, the analyses and a running simulation are not touched. **Delete** removes it (Ctrl+Z brings it back).',
    ],
    notes: [
      'To find your way by context: **Find → Applications, VLANs and VRFs…** lists every application, VLAN and VRF of the model; **Focus** shows the devices each involves (as configured), **Exit focus** (`Esc`) the complete diagram again. A VRF’s focus is its devices with an interface in it and their neighbours on those interfaces.',
      'Many ports at once: select a switch (or another device that bridges: an access point, a transparent firewall) and choose **Bulk edit ports…** in its Inspector or the command palette. Tick the ports, choose the change (**Add a VLAN**, **Remove a VLAN**, **Make access ports of a VLAN**, **Make trunks of VLANs**, **Remove every VLAN**) and its VLANs: the **preview** shows each port before and after, and a port left as it is says why (a routed port, already so). Nothing changes before **Apply**; Ctrl+Z undoes every port at once. Adding a VLAN to an access port makes it a trunk with its old VLAN native, so its untagged traffic stays as it was.',
      'A large model: select a group (or a device in it) and choose **Collapse in diagram** in the Inspector, or **Collapse group** in the command palette. The group is drawn as one box that says how many devices and cables it holds; every cable and relation that leaves the group ends on the box. Selecting the box selects the group; **Expand** draws its devices again. Collapsing is display state, like a filter: a saved view keeps it.',
      'The format is in docs/FORMAT.md (views). A view whose device or focus target is gone opens without it.',
    ],
    figures: [['views', 'Find → Saved views…: the private house’s two views, and a name to save the one on screen.']],
  },
  {
    id: 'experiments',
    title: 'Build and run an experiment',
    steps: [
      'An experiment is a repeatable, explicitly configured sequence of actions and observations applied to a defined architecture and starting state — not an automatic test of everything. Choose **Simulate → Experiments…**: the **Experiments** workspace opens in place of the Objects list and the Inspector. Nothing runs until you press **Run**; opening, saving or editing an experiment never starts one.',
      'On the **left**: the experiments (each with its duration, start and number of steps; **New experiment** adds one), and the selected one’s **name**, **duration**, **start** and **scope**. A duration is a number and its unit side by side (**sec**, **min**, **hours**); another unit converts the number and keeps the duration (60 sec → 1 min), and only a number you enter is written. **Start**: a **Freshly booted network**, one **Settled first** for a while, or **Cold start — boot all devices**: every device with a power lifecycle is off when the run starts and boots as it normally does (its boot time; a VM after its host); boot time is experiment time. **Scope**: the entire model, **Targets and their dependencies** (what the steps name, with their DHCP and DNS providers and the network they need), a group, a VLAN, a failure domain or a device’s dependency slice. Then the sequence: **Actions** and **Observations** as readable entries, each marked **✓** configured or **⚠** with what is missing.',
      'On the **right**: the selected step. What it does or observes; **When**: after the start, or after an earlier action is *submitted* (a time never promises that a prerequisite has happened); its **target** and fields, each said when required and missing. An action that lasts — a failure, a shut interface, a power-off, flapping, a stream, an application — has **For**: it is undone after that long; an instantaneous one (a join, a send) has none. An observation states what it **expects** and its **Window**, with what each verdict means and what it reads in the simulation.',
      'What an observation can read: a delivery (a send’s, an application’s, a receiver’s multicast datagrams with **At least**, an MQTT subscriber’s publications on a **Topic**), a device’s state (operational, booting, on, off), an interface or a cable, an **address acquired** (DHCPv4, SLAAC or DHCPv6), a **neighbor resolved** (ARP or neighbor table), a **route available**, a **protocol session established** (OSPF, BGP …, with a peer), a router’s multicast membership, a **timing state** (PTP or NTP synchronized: a protocol state, not an accuracy), a communication, and the saved requirements. A state is satisfied as soon as it holds in its window — *already so* when the window opened, or *reached at* the moment the result names; traffic is counted until the window ends (what was sent is not what arrived).',
      'At the **bottom**: before a run, a short summary (start, duration, actions, observations, scope), what is still missing, and what it will do in order. **Run** plays it in the diagram with the simulation’s own dots, labels and packet inspector — only the experiment’s traffic is shown: its actions’ messages and what they need on the way (a host’s DHCP, its address resolution, router discovery, a receiver’s IGMP, the protocol it observes); the rest of the network runs, hidden. The device states show **Powered off → Booting → Operational**, the action in progress is outlined, and short lines say what the run waits for (*Booting: tv (up at t = 30 s)*, *Waiting for DHCP*, *Resolving neighbor*, *Waiting for receiver delivery*). **Pause**, the speed and **Skip to result** (the rest at once, the same result); **Stop**, **Reset results**, **Compare with the previous run**, **Copy result**.',
      'After a run: each action **submitted**, **waiting** (its device was still coming up: booting, or a guest waiting for its host — not its links: a message sent before a cable has come up finds no route, as on a real device), **timed out**, **undone** or **refused** (with why) at its time; each observation’s verdict — **Satisfied**, **Violated**, **Indeterminate**, **Unsupported** — with what was found, when, and what it read; the events and the comparison. In Communication, **Use in experiment…** adds an experiment that sends the traced communication and observes its delivery.',
    ],
    figures: [['experiments', 'A cold start of the private house playing in the Experiments workspace: the sequence and its start on the left, only the experiment’s traffic in the diagram, the progress, what it waits for and the verdicts so far at the bottom.']],
    notes: ['Experiments run on the shared simulation engine, on scenario time only, from their defined start: every step is an event of the simulation’s clock, so a run gives the same result played, skipped or run again. Hidden traffic still runs and never holds the run or its display back. A narrower scope runs fewer devices: what it leaves out (load on a shared link, other hosts) is not modeled, and the run says how many devices it ran. Finishing the sequence proves nothing — only observations do. Not measured: convergence time, throughput, synchronization accuracy. The format is in docs/FORMAT.md (experiments).'],
  },
  {
    id: 'expectations',
    title: 'Review the design: findings and requirements',
    steps: [
      '**Design review: findings** lists what the consistency checks find (the same as the Problems tab), with the model’s invalid input apart: filter by category (contradictory configuration, missing information, potential risk), severity and object. A finding’s evidence gives its possible consequence, its evidence and the next step (**Go to the field**). Findings that name the same object and field are shown together as possibly one cause — related, not established as one. *No findings* says which checks ran and which the model switches off.',
      '**Design review: requirements** lists the requirements saved with the model. **Evaluate** checks them all against the model (or a simulation snapshot), statically and only when you ask: nothing is sent, and saving one evaluates nothing.',
      '**Add requirement…** opens its editor: a **name**, the **outcome** (must be available, must be blocked, dependency must be viable, timing-source path must exist), the **source** and the **destination** (a device, an interface, an address, device/application, device/service), and optionally what fails first (**After failure of**). For **Must be blocked**, the editor asks how isolation is met: **No communication is possible** (any prevention), **A modeled policy must deny the communication** (a missing route or listener does not count) or **A specified boundary must deny the communication** (that device must deny it). The service, the VRF, the family and a note are under **Advanced options**. **Save changes** writes it to the model (one undo step); results computed before are marked outdated.',
      'Each row shows its verdict and the actual reason: a requirement to block that holds because no route exists says so, as opposed to a policy that blocks it. Its evidence shows the layers, the failure applied, the enforcement path by path and the findings where it stops; **Communication** checks it there, **Edit** and **Delete** change it. While a simulation runs the model is locked: the editor says so, and nothing is ended to make it possible.',
    ],
    notes: ['A timing requirement names the method it accepts: **PTP**, **NTP**, or **either** (both are evaluated and reported, one is enough). PTP needs a compatible source path; NTP a structurally valid source chain to a configured reference. It never establishes that a clock synchronizes or how accurately; on a snapshot the observed synchronization is added. A failure condition is evaluated on the configured model only. Renaming a device, an interface or an application updates the requirements that name it.'],
  },
  {
    id: 'simulate',
    title: 'Start a protocol simulation',
    steps: [
      'Choose **Simulate → Start simulation…**. The dialog opens with the **Protocols** the model uses, all ticked, grouped by layer (*Layer 2*, *Routing*, *Tunnels and overlays*, *Multicast*, *Services*, *Traffic* …), each with how many devices or relations use it; a group says how many of its protocols are ticked (*Routing (3 of 4)*). **Select all** and **Clear** work for the whole list and for each group. The keyboard starts on the first protocol.',
      'First, the **Execution scope**: what runs. **Entire model** is the default; the other choices are those that apply now: **Selected communication** (the Communication result on screen: its evaluated paths, every alternative and the way back), **Dependency slice** (the selected device and the providers of its dependencies), **Site or group** (the selected group), **VLAN** (of the selected VLAN interface or access port) and each **Failure domain**. A scope says how many devices it runs; what was added for it to run faithfully (the routing domain its routes come from, the switches between, its DHCP and DNS servers, a gateway group’s members) and its boundary are behind an expansion. The scope is what runs, not what is drawn (the filters) or what an analysis evaluates.',
      'Then **Senders**, open: which devices you want to watch (see *Choose the senders*). With devices selected in the diagram, they are chosen; otherwise every device.',
      'Below, the **Layer 1–4 parameters**, one collapsed section per layer (*Layer 2 – Data link (8)*): open one to change a value (its default and source are under it; a changed value is marked *modified*, and the collapsed section says so: *Layer 3 – Network (8) · 2 modified*; **Reset** puts it back). Usually the protocols and the senders are all you choose.',
      'Press **Start** (or `Enter`); `Esc` cancels. The protocols and the values are remembered for the next start in this browser session.',
      'The network starts like a freshly booted one: every table empty, every adjacency down, the interfaces coming up. Its messages appear as dots with labels such as *ARP Request (broadcast): who has 10.0.0.2?*, *OSPF Hello*, *TCP [S] → 10.1.1.10:443* or *ICMP Net Unreachable from 10.0.0.1*. A dot’s shape says how it is addressed: a circle unicast, a square broadcast, a diamond multicast.',
      '**Exit simulation** (in the simulation panel, the banner, the Simulate menu or the command palette) or `Esc` ends it at once: the Objects list and the Inspector are back with your tab and selection, and the Edit tab can be used again right away. Nothing in the model changes.',
    ],
    notes: [
      'A TCP segment’s label gives the flags of its header in brackets, by their letters and always in this order: **S** SYN, **F** FIN, **R** RST, **P** PSH, **A** ACK, **U** URG, **E** ECE, **C** CWR. So a fresh connection shows *TCP [S]*, *TCP [S,A]*, *TCP [A]* — three packets — then data such as *TCP [P,A] · 120 B*, its close *TCP [F,A]*, a reset *TCP [R]* or *TCP [R,A]*; *[]* is a segment with no flag at all. A protocol that runs over TCP keeps its name and adds the flags: *BGP OPEN [P,A]*, *MQTT PUBLISH [P,A]*, and *BGP TCP [S,A]* for its connection’s own segments; *(retransmission)* marks a segment sent again. The packet inspector lists the same flags with their names.',
      'A value configured on a cable or a relation in the model comes first, then the object’s own Simulation value (an interface’s, a VLAN’s, a relation’s, a DHCP scope’s or a DNS zone’s), then the device’s, then the simulation’s value, then the default; every value says which it is.',
      'In a scoped simulation, a device outside the scope is not run at all: its status says **Not run**, nothing answers from it, and traffic sent towards it is logged as leaving the execution scope. The panel says how many devices run and how many do not; when the simulation can’t keep up with its rate, it says so and suggests a smaller scope.',
      'This is a teaching and design-review simulation of protocol behaviour, not an exact protocol implementation: no vendor differences beyond the parameters.',
      'Everything happens inside NetAtlas: simulated packets travel only through the model on screen. Nothing is sent to a real network, and the page makes no network connections.',
    ],
    figures: [['sim-scope', 'The execution scope in Start simulation: Building A of the campus runs 11 of 12 devices, its DHCP and DNS servers and the switches between included; the cable to the controller is its boundary.'], ['sim-start', 'Start simulation…: the protocols first, grouped with their counts; the Layer 1–4 parameters collapsed below, Layer 3 saying it has a modified value.'], ['tcp-syn', 'A TCP test from pc to srv, physical view: the first segment, *Test · TCP [S] → 10.0.2.10:443*.'], ['tcp-synack', 'Its answer on the way back from srv: *TCP [S,A]*.'], ['tcp-ack', 'pc’s request right behind its ACK: *TCP [P,A] · 120 B*.'], ['tcp-logical', 'The logical view: a BGP session’s own handshake along its eBGP relation, *BGP TCP [S,A]*.']],
  },
  {
    id: 'sim-layout',
    title: 'Work in the simulation layout',
    steps: [
      'While a simulation runs, the window has three parts around the diagram. On the left, **Simulation setup**: the **Protocol traffic shown** (as in the dialog; a change never restarts anything, the simulation keeps running every protocol), the **Senders** (collapsed; its heading sums them up), the **Layer 1–4 parameters** (a change applies at once and is written to the event log), and the **Table timers** scale.',
      'On the right, **Actions**: **Network events**, six actions each with its own form: **Send network packets**, **Join multicast group**, **Leave multicast group**, **Start multicast stream**, **Interface actions** and **Start application** (each chooses its device and interface itself; nothing needs to be selected first). The two buttons beside the **Network events** heading, **Expand all** and **Collapse all**, open or close those six forms at once (not Active events, not a form’s **More options**); hiding a form keeps what you typed and stops nothing; a button that would change nothing is disabled. Below them **Active events**, everything they started with its state and result, and the other changes in effect (a failed cable, a device powered off); then the selected device’s **Simulation** settings. A click in the diagram opens a menu for that object: **Fail link**, **Power off**, its tables, its broadcast domain, and the four actions with that device filled in.',
      'Under them, the **simulation panel**, by default its header and exactly three rows of the status and three of the log (also its lowest; measured, so it fits the theme and zoom): **Play / Pause**, **Step**, the state (*Playing*, *Paused*, *Paused: inspecting packet*), the **Speed**, the **Pacing**, **Skip idle time**, the simulated time and **Exit simulation**; on the left the **Status** of the protocols’ sessions, or a table of the selected device; on the right the **Event log**, filtered by text, layer, cast and protocol, and **Show all senders**. While you point at the log or use it, new events wait, so that a row doesn’t move under your click. Drag the line above the panel to change its height (or focus it and use `↑` `↓`, `Enter` for the default; double-click it for the default); it is remembered.',
      '`F6` moves the keyboard between the setup, the diagram, the actions and the simulation panel (`Shift+F6` back).',
      'After **Exit simulation** the Objects list and the Inspector are back, with the tab and the selection you had; the diagram keeps its zoom and position.',
    ],
    notes: ['In a window narrower than 1100 px the side panels are narrower. Below 860 px **Setup** and **Actions** are tabs above the simulation panel; in a window that is also not tall, **Diagram**, **Setup** and **Actions** take turns there. The page never scrolls.'],
    figures: [['simulation', 'The simulation layout for the example enterprise-campus.yaml: Simulation setup on the left, core1’s actions on the right, the simulation panel under the diagram with core1’s ARP table and the event log.']],
  },
  {
    id: 'sim-pacing',
    title: 'Follow the messages: pacing and speed',
    steps: [
      'Every message travels its whole way: in the **Physical** view hop by hop along every cable and through the switches, in the **Logical** view along the whole relation (inside its tunnel). It fades in at its sender, its label stays with it, and it ends with a pulse at the receiver; the devices sending and receiving are marked for that moment. A lost message stops where it was lost and shows ✕ for about 1.5 seconds.',
      '**Pacing: Readable** (the default) gives each hop 3 to 5 seconds on screen at 1×, from its modelled traversal time on a scale of the model’s own cables: the quickest cable takes 3 seconds, a slower link, a larger frame or a relation over a longer underlay longer, never more than 5. A line drawn in two halves (to a network, a hub or a bus and on) takes the time of one line. A hop without any modelled time takes 4 seconds. These seconds are presentation only: the *modelled network time* (latency and serialization, shown in the log and the packet inspector) is unchanged and is never seconds of screen time. **Proportional to latency** shows each hop for its real time times a scale (*1 ms = 1 s*), and there a dot never moves faster than 70 pixels a second at 100 % zoom, so a long cable takes longer. The **Speed** (0.1× to 4×; 1× is the default) applies on top: 2× halves the screen time, 0.5× doubles it; a pause holds every dot where it is. The panel shows the pacing in use, e.g. *Readable · 3–5 s/hop · 1×*.',
      '**The diagram first.** In Readable and Proportional pacing a delivery you see waits for its dot: the switch learns, the server answers, the next hop starts only once the dot has reached that device on screen, and then at the delivery’s own simulated time. So a packet that waited for ARP leaves when the ARP reply has visibly arrived, a SYN-ACK after the SYN, a switch’s member port after the report. Meanwhile everything already on its way keeps moving, so independent exchanges are on screen together, and the pacing text says what it waits for (*waiting for packet arrival (establishing TCP)*). Readable playback waits for displayed deliveries; network delays, protocol timers, application intervals and retries still use simulated time, so what happens never changes with the pacing, the speed or what you show.',
      '**One of each, then the steady state.** The scenario’s messages are shown in detail one of each kind (an ARP request, a DHCP Discover, a TCP handshake, a Hello); the same kind again is cable activity (a lit cable with *protocol ×n*) and nothing waits for it, until your next change makes the scenario news again (a Network event, a failure or restore, a power change, a shut or no shut). Only what the diagram draws holds the simulation: a dot filtered out, inside a collapsed group or switched off by IP / Non-IP waits for nothing. Your own Network events, their prerequisites and the message you follow are always shown in detail. A stream is a flow on every cable of its tree, with one datagram after each join or leave shown hop by hop. **Real time** pacing is the overview: it waits for nothing. With **Skip idle time** on (the default), when nothing is on screen the clock jumps to the next message that will be shown (*⏩ 9.8 s skipped*). The time shown is always the real simulated time.',
      'Click a dot (or a message in the event log): the **packet inspector** opens and the simulation pauses (*Paused: inspecting packet*). It plays again by itself when you close the inspector (**×**, `Esc`), or it is gone from the window — not when you click or tab elsewhere, or another window covers it for a while (**Play** resumes at once). If you paused it yourself, it stays paused; the state’s tooltip says who paused it and what ends it. **Follow message** keeps that message and its replies (an ARP request and its reply, a ping and its echo, a TCP handshake) always drawn, plays on beside the open inspector and draws its trail; the others are drawn faint. **Stop following** in the panel ends it.',
      '**Step** moves to the next message event: a message arrives, or the next one starts at its sender. **Next exchange** moves on to the end of the exchange first on screen (an ARP request and its reply, a ping and its echo, a hello), or of the next one to start.',
      '**Your events in front.** While something you started under **Network events** runs (a send’s messages, a stream, a join until it is recorded, a leave until its cleanup settles, flapping), and until its last dots have arrived, its traffic is the foreground: everything it causes — its messages, their copies, the answers, the ARP it needs — is drawn normally, labelled and clickable. The scenario goes on underneath as the background: its dots keep moving, but **grey**, each kind with a short grey label (*IGMP Query*, *ARP*, *DHCP*, *UDP* — one per cable and kind, only where there is room), and the pointer goes through them and their labels (no outline, no inspector; the event log and the tables have them all). Several of your actions at once are all in front. A finished event, the membership a join leaves behind, or a card kept in Active events mutes nothing. The panel says *· your events in front*. One network and one clock: what you do (a shut, a join) changes what the scenario does, and the reverse.',
      '**Streams.** A stream you start under **Network events** sends one datagram at once and then one every interval of **simulated time** (1 s: every simulated second), as the model’s own streams do: the pacing, the speed and how busy the page is change only how fast its datagrams are shown, never which ones exist or when they are sent in the scenario. Several streams run side by side, each on its own interval from its own start: two 1 s streams each send every simulated second, and starting or stopping one never changes another. In Readable pacing a simulated second takes longer than a real one while dots are on their way, so a stream’s datagrams follow one another more slowly on screen; **Real time** pacing shows them a real second apart (times the speed). Multicast data is shown as a **flow**: each copy is on its cable from the moment it is forwarded, on every cable of its way at once — so a join or a leave shows with the next datagram, not after the earlier ones have crawled along the whole way. Paused, nothing is sent (the simulated clock stands). A reply of a send is drawn after the message it answers has arrived on screen.',
      'The scenario is **bundled**: at most 6 of its exchanges are drawn as dots at once, each to its end — and a few more for protocols with nothing else on screen, so a burst of DHCP and ARP never hides an IGMP query or a Hello — the others as **cable activity** (a cable lit with a short count, *OSPF ×3 · ARP ×1*). An exchange whose next hop would show more than 15 s after it happened is cable activity too, so the dots stay close to what is happening. So many things at once stay followable, a few at a time.',
      '**Pacing: Real time (1 s = 1 s)** runs the simulated clock with the real one (times the speed): a 1 s interval of a send is a real second. Every hop shows briefly as a sign of its traffic, bundled as above, and idle time is never skipped. In every pacing, when the simulation has more work than a frame allows, it falls behind and says so (*· behind*), and goes on from there instead of catching up in a burst: the page stays responsive.',
    ],
    notes: [
      'The pacing, the speed and skipping only change how the simulation is shown: what happens, and in which order, is the same with every setting.',
      'Every hop gets the same time on screen from the very first one: the clock starts with the first frame drawn, a slow frame counts at most 0.1 s (the dots slow down for a moment instead of jumping), and a hidden tab stops it.',
      'A moving dot’s label is placed when the dot appears, where it touches nothing, and keeps that place beside its dot all the way: it moves with the dot and may pass over a name or another label for a moment instead of jumping away. At most 48 messages are drawn at once, and at most 6 of the scenario’s exchanges; the panel says how many more are shown as cable activity, and the event log lists every message.',
      'Every interval is simulated time — a send’s messages, flapping, a stream, an application’s repetitions: results such as round trips, timeouts and aging stay right and the same every time, whatever the pacing; in Real time pacing a simulated second takes a real second.',
      
      'With reduced motion set in your system, each message is a still arrow with its label, shown for the same paced time; **Step** moves one message at a time.',
    ],
  },
  {
    id: 'sim-senders',
    title: 'Choose the senders',
    steps: [
      'Every device of a network talks; to follow some of them, choose them as **Senders**: in **Start simulation…** (open), or in the **Simulation setup** (collapsed; its heading says who, e.g. *Senders (3 of 23): hq-rtr1, muc-rtr, client-1…*).',
      'Type in the filter box to find devices, or use **All**, **None**, **Selected in diagram**, **By type ▾** (only the devices of a type) and **By group / site ▾**. The list is grouped by **Type** or by **Group / site**; each group folds and says how many of its devices are chosen (*Routers (2 of 5)*).',
      'Only the senders’ messages, and the exchanges they start (ARP and NDP replies, a TCP handshake’s answers, ACKs and RSTs, ICMP errors, a protocol’s replies, the copies routers forward), are drawn and listed in the event log. The log says how many messages of other devices it leaves out; **Show all senders** lists them.',
      'The choice is what you see, never what runs: every protocol still runs on every device, so adjacencies and tables are exactly as without it (OSPF reaches Full even when one neighbour is not a sender), and every device generates what its own settings say — its optional test traffic (the Layer 4 parameter **Test traffic**) and its applications that start with the simulation.',
      'During the simulation, a device’s menu offers **Use as sender** or **Stop as sender**; a change applies at once and is written to the event log. While not every device is a sender, the senders have a small ▶ badge at their box’s corner.',
    ],
    notes: ['The choice is remembered for the next start in this browser session; it is never written to the model.'],
    figures: [['senders', 'Senders in the Start dialog: grouped by type, the routers chosen with By type ▾, with icons and the switches’ L2 / L3 badges.']],
  },
  {
    id: 'sim-device',
    title: 'Set simulation values where they belong',
    steps: [
      'Select a device, open the **Edit** tab and open its **Simulation** section (it is collapsed; its name says how many values it has). It holds what belongs to the whole device: its boot time, the spanning-tree mode and bridge priority, a firewall’s policy …',
      'What belongs to one object is in that object’s own collapsed **Simulation** subsection: an interface card (ARP timers, a port’s spanning-tree cost, **Edge port** and **BPDU guard**, IGMP, a DHCP client’s retries …), a network with a VLAN (the snooping querier, fast leave), a relation (a VRRP group’s advertisement interval, an IPsec tunnel’s lifetimes, a load balancer pool’s health checks), a DHCP scope, a DNS zone. Some of them can also be set on the device, as the default for all its objects (*Inherited: device*).',
      'Each field shows the value in effect: its own, or *Inherited* with where it comes from. Type a value to override it (with its unit, e.g. *300* seconds or *50ms*); empty it, or press **Reset to inherited**, to inherit again. Only overrides are saved, in the `simulation:` block of the device or object.',
      'During a simulation the model is locked, but this section stays editable: it is at the bottom of the **Actions** panel for the selected device. A change applies at once and appears in the event log; **Undo** takes it back.',
    ],
    figures: [['sim-device', 'core1’s Simulation section in the Actions panel during a simulation: its own ARP timeout and MAC aging, the other values inherited with their sources.']],
  },
  {
    id: 'sim-tables',
    title: 'Look at ARP and MAC tables',
    steps: [
      'During a simulation, click a device: its menu offers **Show ARP table**, for a switch **Show MAC table**, **Show connections**, for a firewall **Show sessions**, for a DHCP server **Show DHCP leases**, for a DNS server **Show DNS zone**, and for a host that resolved names **Show DNS cache**.',
      'The table shows on the **Status** side of the simulation panel; the buttons above it switch between the protocols’ status and the selected device’s tables.',
      'At the top: the timers in effect, each with where it comes from (*device*, *simulation* or *default* and its source). The rows show the address, the MAC (*(simulated)* when NetAtlas generated it), the interface, VLAN, type, state, age and when it expires.',
      'The ARP timeout is 4 hours by default: choose a faster **Table timers** scale in the setup to see entries age in a demonstration. It changes nothing in the model.',
    ],
    figures: [['arp-table', 'core1’s ARP table in the simulation panel: the timers (its own ARP timeout of 5 minutes), and entries with generated MAC addresses.']],
  },
  {
    id: 'sim-test',
    title: 'Send a test and inspect a packet',
    steps: [
      'During a simulation, open **Send network packets** under **Network events** in the **Actions** panel, or click a device and choose **Send network packets…** (it becomes the source). First choose the **Delivery**: **Unicast** (one destination), **Multicast** (a group), **Local broadcast** or **Directed broadcast**. Until then **From** and **To** are greyed; afterwards only what that type uses is shown.',
      '**From** lists every device. One that can’t send is greyed with a short reason: *Cannot send IP packets* (a Cloud, a TAP, a passive monitor), *No IP address* or *Powered off*. A device with several interfaces offers **Interface**, each as *name - address*: a DHCP client’s with its lease now, or *No DHCP lease*. For unicast there is also *Chosen by routing*. A device with one interface shows it as text.',
      '**Unicast:** **To** is a device, then its **Interface**: each of its addresses is an option, one of several must be chosen, and a single one is shown. *Address or host name…* lets you write one instead (a host name is resolved by DNS first). The address chosen is the target; routing, VLANs and policies still decide whether it gets there. **Multicast:** the **Group** (224.0.0.0/4 or ff00::/8). Its members receive it, as the group membership and multicast routing decide; nobody answers. **Local broadcast:** the **Scope**, *Limited* (255.255.255.255) or the interface’s *Subnet* broadcast. It stays in the source’s broadcast domain (its VLAN). **Directed broadcast:** the target **Subnet** (*10.1.2.0/24*, or its broadcast address), another subnet of the model. Routers send it on as a broadcast only where **Forward directed broadcasts** is on (off by default); elsewhere it is dropped and the result says where. IPv6 has no broadcast: use Multicast (*ff02::1* reaches every node of a link).',
      'The **Protocol**: unicast offers ICMP (ping), TCP and UDP; multicast UDP; a broadcast ICMP and UDP (TCP connects to one host). **Port** appears for TCP and UDP only, and is empty until you enter one. The count — **Echo requests** for ICMP, **Datagrams** for UDP, **Connections** for TCP — and **Interval** send a series: message *n* leaves at the start plus (*n* − 1) intervals of simulated time, whether or not the earlier ones were answered (at most 1000 messages, 0.01 s to 3600 s apart). One message is one ping, one UDP datagram or one TCP connection attempt (its handshake, request, answer and close). With **TCP: keep each connection open** (More options), each connection stays open after its handshake — with several, each is its own connection — until it is closed or reset; an idle one is probed after the TCP keepalive time. Replies, retransmissions, and the copies a switch or router makes of a broadcast or group, are not more messages. Until everything needed is filled in, **Send** is disabled and the line under it says what is missing. Changing the delivery type or protocol clears what no longer applies.',
      'A DHCP client needs its lease first: it asks for one when its link comes up. A test sent before that waits for the lease (the log says so) and goes from the leased address; if DHCP gets no answer, the test ends with *not sent: … has no DHCP lease* and the reason. Nothing is invented meanwhile.',
      '**More options** has the data size, **Don’t fragment** and, for TCP, keeping the connection open. Press **Send** (or `Enter` in a text field). The first message goes at once, at the current simulated time, in parallel with everything else on screen: only what it really needs (ARP, a DNS answer, a DHCP lease) comes first. Paused, **Send** sends it at the current time and it moves when you press Play; **Send and play** does both. A series follows the simulated clock: paused, nothing more is sent, and the playback speed only changes how fast you watch it. It is listed with how many messages were sent, answered and failed, and the latest result; **Stop** ends it (messages already on their way finish).',
      'Its messages and their answers are always drawn, whatever the senders and protocols chosen and before other dots when many are on screen; their labels start with *Test ·*, the event log marks them **Test**, and they draw a trail. While the test is on its way it alone sets the pace (the other dots keep moving).',
      'The result shows under it, in the Status table and in the event log: *answered* (with the round trip), *connection refused* (a TCP RST from a closed port), an ICMP error that came back (*Net Unreachable*, *Port Unreachable*, *Administratively Prohibited* from a firewall, *Fragmentation Needed* …) or *timed out*; a timeout says where the last of its packets was dropped (a firewall’s policy, no route, a VLAN a port doesn’t carry). A missing prerequisite (*not sent: …*), a policy that drops it and an unreachable destination are each said as such; the source stays in **From** either way.',
      'Click a dot, or near it, or the message of a row in the event log (Enter on it from the keyboard): the **packet inspector**. A packet within about 12 pixels of the pointer, at any zoom, is outlined with a ring and the pointer becomes a hand; the nearest one opens. The inspector keeps that packet while the simulation moves on. It shows its frame layer by layer: the MAC addresses and what they are (broadcast, a multicast group’s MAC), the VLAN tag, the IP header (TTL, Don’t Fragment, protocol), the ports and TCP flags or the ICMP type with the quoted header, and what it carries; **Follow message** follows it and its replies.',
      '**Show connections** on a device lists its open ports and connections (LISTEN, ESTABLISHED, TIME_WAIT …); **Show sessions** on a firewall its session table with the rule that permitted each.',
    ],
    notes: [
      'Endpoints can send test traffic by themselves: turn on **Endpoint test traffic** under Layer 4 (or in an endpoint’s Simulation section). They ping their gateway and test the servers of their service relations every few seconds.',
      'Which ports a server listens on: its **Listening services**, else the ports of the relations it serves. Without a written network policy, a firewall passes the model’s relations and what its **Also permits** list allows; anything else it drops, or rejects. With one, its rules decide (see *Run routing protocols on a device*).',
    ],
    figures: [['send-test', 'Network events: its actions; Send network packets open for a unicast series: the delivery type first, the source and its interface (name - address), the destination and its one interface shown, UDP with its port, ten messages a second apart.'], ['active-events', 'Active events, the newest on top: two multicast streams side by side, each a datagram every second of simulated time with its receivers and Stop stream; below them a series of ten pings in progress: its state, the messages sent of those requested, the outcome bar, Stop and its details.'], ['packet-inspector', 'The packet inspector for a TCP SYN on its way, with Follow message: the Ethernet header with its MAC addresses, the IPv4 header with TTL and Don’t Fragment, the TCP ports and flags.']],
  },
  {
    id: 'services',
    title: 'Run DHCP and DNS servers',
    steps: [
      'Select a router, a Layer 3 switch, a routed firewall, a server, a VM or a container and open the **Edit** tab. Its **Services** card has the checkboxes **DHCP server** and **DNS server** (as far as it may run them), both off (a server’s also **Hypervisor** and **Container engine**: see *Model hypervisors, VMs and containers*).',
      'Tick **DHCP server**: it needs a scope, reported as an error until there is one. Press **+ Add scope** and fill in the **Network**, the **Address range**, the **Default gateway** and the **DNS servers**; the buttons under them suggest a free range, the network’s gateway and the model’s DNS servers. **Lease time** (1 day if empty), **Excluded addresses**, **Reservations** (a MAC address and its address) and **Domain name** are optional.',
      'Tick **DNS server** and press **+ Add zone**: name it (*campus.example*). The model’s DNS names in that zone are its A and AAAA records, listed read-only with the interface each comes from; add your own A, AAAA and CNAME records under them. **Listening address**, **Forwarders** and **Reverse zones** are optional.',
      'A client is an interface with **DHCP** on. In another subnet, give its gateway interface a **DHCP relay** (the server’s address). A host’s **Name resolution** card lists its static DNS servers, used when no lease gives any.',
    ],
    notes: [
      'The diagram writes **DHCP** and **DNS** in the server’s badge line and marks each client interface with *DHCP client*; the legend explains them. The checks report a client that reaches no DHCP server and a relay to an address that is none.',
      'Unticking a service removes it with its scopes or zones in one step you can undo.',
    ],
    figures: [['services', 'srv’s Services card in enterprise-campus.yaml: DHCP with its two scopes, DNS with the zone campus.example.']],
  },
  {
    id: 'services-wifi',
    title: 'Add services and Wi-Fi networks',
    steps: [
      'Select a device and open the **Edit** tab. Its **Services** card lists the services it runs. **Add service…** offers the ones it may run; the others are listed disabled under *Not available here*, each with the reason (*a Layer 2 switch routes nothing: tick Supports Layer 3 first*).',
      'Choose a service: its card appears with its fields, and what it still needs is an error until you fill it in (an NTP server’s **Stratum** or its **Upstream servers**, an AAA server’s **Protocol**, **Shared secret** and **Clients**). Nothing is chosen for you. Write a secret as a placeholder such as *<radius-secret>*. **Remove** lists what goes and is one step you can undo.',
      'An access point’s **Wireless access** is built in (a router may add it). Press **+ Add Wi-Fi network** and fill in its **Network id**, **SSID**, **VLAN** (or tick **Untagged**), **Radio** and **Security** (a **Passphrase** placeholder for a Personal one). Add one network per SSID: Staff, Guest and IoT on VLANs 10, 20 and 30 share one radio and one uplink.',
      'Give the uplink the VLANs: a trunk port with *10, 20, 30*. An error names a network’s VLAN that no wired port carries. Connect each client to the radio and choose its **Wi-Fi network** in the cable’s Edit card; the radio takes several connections.',
    ],
    notes: [
      'A client is in its network’s VLAN only: the path tracer and the simulation give it that VLAN’s DHCP lease and keep Guest away from Staff unless a routed path allows it. Resilience lists the uplink with every client behind it among the single-component failures.',
      'The diagram writes a device’s services in a line under its type, at most three and how many more; hovering it names them all. Find a Wi-Fi network by its SSID or VLAN (*Guest*, *vlan 20*). There is no radio-frequency or roaming model; a network tunneled to its controller is reported as not simulated. See **private-house.yaml**, **enterprise-campus.yaml** and **dmz-services.yaml**.',
    ],
    figures: [
      ['wifi-edit', 'ap-b’s Wireless access in private-house.yaml: Internal, IoT and Guest on VLANs 10, 20 and 30 of radio0, each with its clients.'],
      ['services-add', 'srv’s Services card in enterprise-campus.yaml, below its DHCP and DNS servers: NTP with its stratum and AAA with its protocol, its placeholder secret and its clients.'],
    ],
  },
  {
    id: 'applications',
    title: 'Run applications on a device',
    steps: [
      'Select a server, a VM, a container, a storage device or an **Endpoint** that is a host (a PLC, an HMI, a camera, a printer, an IoT device …) and open the **Edit** tab. **Add service…** → **Applications** adds its list; a device keeps its type. A TAP, a monitoring System and a Security gateway run none (the reason is said).',
      'Press **+ Add application**: a new entry opens with the keyboard in its **Profile**, nothing chosen for you. The profiles: **TCP listener** and **TCP client**, **UDP listener**, **UDP client**, **UDP receiver** and **Periodic UDP messages** (one-way), and **MQTT client** (publisher, subscriber or both). Each shows only its own fields; sizes, delays, timeouts, retries, the IP version and the bind interface wait in its closed **Advanced** section, with the modelling defaults as placeholders.',
      'Give a client its **Peer**: an application of another device (*plc/registers*: its port follows from it) or a device, address or host name with a **Port**. The field offers the listeners its profile can talk to. An MQTT client chooses its **Broker** (a device with the MQTT broker service), its **Publishes to** topics and its **Subscribes to** filters (`+` one level, `#` the rest).',
      'Closed, each entry is one line: *Name · profile · port or peer*. **Duplicate** copies one with its own id; **Remove** first lists the applications that name it as their peer (they report their missing peer afterwards). Each is one step you can undo; renaming a device or an application renames the peers that name it.',
    ],
    notes: [
      'A name only labels an application: one called *Modbus TCP* is TCP requests and answers, not Modbus. Two listeners on one port, a listener on a service’s port (NTP 123, MQTT 1883, PTP 319 / 320 …), a peer that is missing or cannot answer this profile and a client identifier used twice at one broker are errors at their fields.',
      'The **ⓘ** beside a profile, a service or a protocol says how far NetAtlas goes with it: *Diagram only*, *Configuration and validation* or *Modeled behavior*. Open it (a click or `Enter`) for two lines: what is simulated, and what is not.',
    ],
    figures: [['applications', 'The thermostat’s applications in private-house.yaml: Local control, a TCP listener, and Cloud sync, a TCP client of web/web, opened with its fields and its closed Advanced section.']],
  },
  {
    id: 'ipv6',
    title: 'Give hosts IPv6 addresses',
    steps: [
      'Select a host interface in the **Edit** tab. Its **IPv6** field is one choice: **None** or **Static** (the addresses written in its address list), **Automatic (SLAAC)**, **Automatic (DHCPv6)**, or **Automatic (SLAAC and DHCPv6)**. Its IPv4 method (**DHCP** or written addresses) is independent: a dual-stack client has both.',
      'On the router’s interface of that link, tick **Router advertisements** and write its **Prefixes** (its own /64s are offered, never filled in). **Advanced** holds the DNS servers it advertises, the managed (M), other (O) and autonomous (A) flags, the lifetimes and the interval, with RFC 4861’s defaults as placeholders.',
      'For DHCPv6, give a DHCP server a scope of the IPv6 network: with an **Address range** it leases addresses, without one it gives DNS servers only. A DHCPv6 scope has no default gateway: hosts learn their router from the advertisements.',
    ],
    notes: ['In a simulation each interface’s status says what it got: *SLAAC address acquired*, *DHCPv6 pending*, *No default router*, *Duplicate address* or *Address deprecated*; **Show IPv6 configuration** lists its addresses with their lifetimes, its default routers and DNS servers. In private-house.yaml the Internal network is dual-stack. Prefix delegation and DHCPv6 relay are not modelled.'],
  },
  {
    id: 'virtualization',
    title: 'Model hypervisors, VMs and containers',
    steps: [
      'A hypervisor is a server with the **Hypervisor** service: select a server, open the **Edit** tab and tick **Hypervisor** in its **Services** card. Choose its **Platform** (ESXi, KVM, Hyper-V …), optionally its **HA cluster**, and press **+ Add virtual switch**: its **Name**, **Type**, **Uplinks** (the host’s ports, in teaming order), **Teaming** and **+ Add port group** (a name and its VLANs, as on a port, or **Guest tagging**).',
      'Press **+ VM** under *VMs on this host*: a new VM that runs on it. A guest’s first field is **Host**, which offers only the servers that can run it. Give it **+ Virtual NIC**: its **Port group** (or a **Passthrough port**) and its address; **Generate** gives it a MAC address with the platform’s OUI. A hypervisor’s own interfaces are **+ Host interface**, each with its **Role**.',
      'A container host is a server (or a VM) with the **Container engine**: tick it, choose the **Engine** and add container networks — **Bridge** (its interface, subnet, gateway, NAT and address range), **macvlan** / **ipvlan** (on a parent interface), **Overlay**, **Host** or **None**. **+ Container** adds a container on it; its **+ Network attachment** names the network, takes the **Next free** address and may publish ports (host port → container port).',
      'The physical view draws each guest inside its host, wired to its port group or network, with the uplinks from the host’s ports; dragging a guest moves its host. The logical view shows guests as devices that say where they run (*runs on esx-01*), and a NAT bridge as a network behind its host.',
    ],
    notes: [
      'A guest has no ports, no cables and no location of its own (its host’s). Unticking a service its guests run on, or deleting the host, asks first and names the guests; their host then shows as an error until you move or delete them.',
      'The checks report a port group VLAN that an uplink’s switch port doesn’t carry, a guest address in the wrong VLAN, a macvlan network in another VLAN than its parent, a VM HA can’t restart elsewhere and an overcommitted host. Kubernetes is not modelled: a node is a container host.',
    ],
    figures: [
      ['virtualization', 'esx-01 in virtualization.yaml: vSwitch0 with its port groups, the VMs wired to them, a container inside the VM k8s1, the internal vSwitch1, and db1 on its passthrough port.'],
      ['virtualization-edit', 'esx-01’s Services card: the Hypervisor with its platform, HA cluster and inventory, its two virtual switches (collapsed), and the VMs on the host with + VM.'],
    ],
  },
  {
    id: 'device-model',
    title: 'Say what a device is',
    steps: [
      'Select a device and open the **Edit** tab. Its *Identity* card says what it is, in order: **Type**, then **Kind** (optional: the type’s kinds, such as *NGFW* for a firewall or *PLC* for an endpoint, or **Other** with a **Kind name** of your own), then **Role** (optional: *core*, *access*, *spine*, *leaf*, *border* … or your own).',
      'A firewall, an IDS/IPS and an access point have a **Mode**: a firewall *Routed* or *Transparent* (it bridges its data ports and filters what passes), an IDS/IPS *Inline* (between its paired ports) or *Passive* (it receives copies). A System has a **Purpose**, required and not preselected (host, Layer 2 or Layer 3 forwarder, inline, passive monitor, pass-through, external network), and an **Icon** among its purpose’s.',
      'An inline device and a pass-through System have a **Port pairs** card: press **+ Add port pair**, choose its two ports, its direction, and the monitor ports that get a **copy** (a TAP). A firewall, an IDS/IPS or a Security gateway lists its **Management interfaces**: never forwarded.',
      'Changing the type, the mode or the purpose asks first when something would no longer fit, lists it and what stays but is then reported, and does it in one step you can undo. Nothing new is chosen for you.',
    ],
    notes: [
      'What a device does follows from these choices, everywhere: in the checks, the path tracer, the simulation, single points of failure and Auto-arrange, which puts a known role in its row. Find and the palette find a device by its role or kind (*core*, *plc*).',
      'A Cloud is an external network crossed as one Layer 3 hop. A public cloud is a group of the kind Cloud region, VPC or VNet with its provider; a VM or container in it may be a cloud instance, without a host.',
    ],
    figures: [['device-model', 'pgw in ot-network.yaml: a System whose purpose is Layer 3 forwarder, with its kind name and its icon.']],
  },
  {
    id: 'interconnects',
    title: 'Model a USB, serial, bus or backplane connection',
    steps: [
      'On each device, add the port with **Port stack** *Opaque*: it has no network stack (no address, VLAN or MAC), and nothing of the IP side ever uses it.',
      'Add an **interconnect** (in the YAML: *interconnects:*). Its **Topology**: *point to point* (two ports) or *shared* (a bus or backplane with several attachments). Its **Technology** and version (*USB* *2.0*, *RS-485*, *CAN FD*, *VME*: suggestions, any text), and optionally the **Protocol** over it and the **Connector**.',
      'Its **Access**: *peer* (every participant sends its own data) or *controller / target* (controllers initiate). Each endpoint gets its **role** (Controller, Target, Controller and target, Peer, Monitor) and its **Data** direction (*both*, *send*, *receive*): the direction is written there, never taken from the order of the endpoints.',
      'A fabric switch or an active hub passes data between its ports only where you say so: on a **System**, add a transit group of its opaque ports (*opaque_transit*). Two connections of the same technology are never joined otherwise, and nothing converts one technology into another.',
      'In a simulation, **Network events → Send illustrative data**: choose the interconnect, who **initiates** it, where the data comes **from** and where it goes **to**. A controller reads a target by choosing the target as the source. **Non-IP failures** fail an interconnect, detach one attachment or shut a port; restore them from **Active events**. A failure while data is on its way stops it there.',
      'To have an interconnect carry data whenever the simulation runs, write its **traffic** (in YAML: `traffic:` under the interconnect, each entry with an initiator, a data source, recipients, an interval and a size). It is the scenario’s: drawn every time, shown or hidden with **Non-IP data** in the setup’s list.',
    ],
    notes: [
      'The built-in example **vme-rack.yaml** is such a system, and a starting point for your own: a VME64x crate whose CPUs and I/O boards share the VMEbus backplane and a switched serial fabric overlaid on it (through a switch card with a transit group), a MIL-STD-1553 bus with a monitor, a CAN bus of peers, RS-232 console lines both ways and a GPS line one way, and a USB log stick — and a VME Layer 2/3 Ethernet switch board (a fictional model) that gives every board its IP connection over the backplane and routes the crate to the operators’ LAN. Each interconnect carries its traffic while the simulation runs, and the Ethernet side its applications (a telemetry poll, console sessions, syslog).',
      'The physical view draws a point-to-point connection as a dashed line labelled with its technology and direction (*USB 2.0 ↔*, *RS-232 →*), a bus as a bar you can move with a tap and role badge per attachment, and opaque ports as diamonds. The **IP** and **Non-IP** switches show one side or both; the logical view never shows them. Find (`/`) finds them by technology, protocol or port.',
      'The data is illustrative: it shows where data can go and why it can’t, one way and without a reply. Nothing of USB, RS-485, CAN, VME or any protocol over them is simulated, and the packet inspector says so.',
    ],
    figures: [['interconnects', 'A USB line and a one-way serial line, an RS-485 bus with its controller and targets, and a fabric switch passing SRIO between its payload cards.']],
  },
  {
    id: 'vpn-gateway',
    title: 'Configure a VPN gateway',
    steps: [
      'Give a device the type **VPN gateway**. Its **VPN gateway** card is built in and can’t be removed; press **+ Configure the VPN gateway**. Nothing is chosen for you: its **Operation** and **Technology** are errors until you set them.',
      '**Site to site:** add its **Tunnels**, tunnel interfaces of the device, each with its source (the local end) and destination (the peer). **Remote access:** its **Listener** (the interface its clients connect to) and its **Client pool**. Both: the **Protected networks** behind it.',
      'Route the protected networks through the tunnel (a static route via the peer’s tunnel address, or a routing protocol over it), and trace a path across: the trace shows the encapsulation and its underlay.',
    ],
    notes: ['A VPN gateway forwards only to and from its VPN: traffic between its other interfaces is refused, in the trace and in the simulation. A router or a firewall can run the VPN as a service instead and forward everything else as usual: see **dmz-services.yaml**.'],
  },
  {
    id: 'separation',
    title: 'Separate two security domains',
    steps: [
      'Give a device the type **Security gateway**. Its **Domain separation** card is built in. Choose its **Implementation**, which has no default: a **filtering bridge** (permitted frames pass unchanged; one network on both sides), a **filtering router** (permitted packets are routed) or a **protocol break** (nothing passes through: a transfer ends at the gateway, which starts a new one of its own).',
      'Add its two **domains**: a name each (*Red* and *Black* are only suggestions) and their data interfaces. Tick the **Permitted directions**. List the gateway’s **Management interfaces** apart: they are never forwarded.',
      'Add **rules**: each permits a transfer from one domain to the other, for a source, a destination, a protocol and ports — every field written (*any* when you mean any). The first matching rule permits; everything else is denied, both ways. A protocol break needs a **transfer profile** for each permitted transfer (HTTPS, DNS or syslog: where it listens and where it sends the new transfer).',
      'Check it with **Analyze → Communication** and a **Service** (*tcp/443*): a permitted transfer passes (a protocol break shows **Leg 2**, its own transfer), anything else stops at the gateway with the reason. Start a simulation to see both legs and the denials in the timeline.',
    ],
    notes: [
      'A permitted transfer’s replies come back; starting a transfer the other way needs its own direction and rule. The ports say their domain in the diagram, and the Details tab lists the policy in order.',
      'This is a model of how such a boundary behaves, not of a particular product, and no assurance of a real device’s separation. See **cross-domain.yaml**.',
    ],
    figures: [
      ['separation', 'cdg in cross-domain.yaml: the protocol break between Red and Black, each port with its domain, the management network apart.'],
      ['separation-edit', 'cdg’s Domain separation card: its implementation, the two domains, the permitted direction and the transfer profile web.'],
      ['separation-trace', 'Communication from red-ws to the gateway with the service tcp/443: leg 1 ends at cdg, leg 2 is the gateway’s own transfer to black-web.'],
    ],
  },
  {
    id: 'sim-dhcp-dns',
    title: 'Follow DHCP and DNS in a simulation',
    steps: [
      'Open **enterprise-campus.yaml** and start a simulation. As the links come up, every DHCP client sends a **DHCPDISCOVER** at the same time; the server answers *DHCPOFFER 10.20.10.100 · lease 1 d*, the client requests it and gets a **DHCPACK**. The server *srv* is in another VLAN: each DISCOVER reaches it through the relay on *core1*.',
      'The lease is written into the client’s line in the diagram: *10.20.10.100/24 (DHCP lease)*. Everything else the client sends waits for it (the log says so). It renews at half the lease, rebinds at seven eighths, and loses the address when the lease ends; a full pool doesn’t answer, and the client tries again with longer and longer pauses.',
      'Test traffic and **Send test** to a host name ask DNS first (*DNS A? srv.campus.example*, answered *DNS A srv.campus.example = 10.20.30.10*), then connect; a name missing from the server’s zone ends in NXDOMAIN, an unreachable server in a timeout.',
      'Click the server for **Show DHCP leases** and **Show DNS zone**, a client for **Show DNS cache**.',
    ],
    notes: ['One lease per interface; IPv4 DHCP crosses relays, DHCPv6 is served on the server’s own link only (no DHCPv6 relay). DNS has no negative caching and asks only the model’s servers. The model is never changed: after the simulation the client’s line says the lease is assigned in a simulation.'],
    figures: [['dhcp-sim', 'The simulation of enterprise-campus.yaml: the clients’ leases in the diagram, and srv’s DHCP leases in the simulation panel.']],
  },
  {
    id: 'sim-virtual',
    title: 'Follow virtual networking in a simulation',
    steps: [
      'Open **virtualization.yaml** and start a simulation. A virtual switch learns its guests, never its uplinks, and sends what isn’t theirs by its teaming’s uplink: active / standby uses the first that is up.',
      'Click **esx-01**’s port **vmnic0** and **Shut interface**: after the teaming failover detection (1 s) the switch fails over to vmnic1 and sends a **RARP** for each guest, so the switches learn where they are now. **No shut** and it fails back.',
      'Click **esx-02** and **Power off**: its VMs go down with it, and after the HA cluster’s **VM restart time** they restart on esx-01, drawn inside it for the rest of the simulation. *db1*, bound to a host port by passthrough, can’t move.',
      '**Send test** from *web* (a container behind docker-01’s NAT) to *pc1*: the log shows the **SNAT** to the host’s address and the reply translated back; a test from *pc1* to docker-01 on TCP 8080 reaches *web* by its **published port** (DNAT). **Stop container engine** on docker-01 stops its containers; started again, each comes back as its **restart policy** says.',
    ],
    notes: ['The VM restart time, the failover detection and the container start time are the services’ Simulation attributes (in their cards); the restart policy is the container’s. A VM drawn in its new host is the simulation’s picture only: the model is never changed.'],
    figures: [['sim-ha', 'The simulation of virtualization.yaml after esx-02 was powered off: app1, vr1 and lab1 restarted on esx-01, marked as moved.']],
  },
  {
    id: 'sim-multicast',
    title: 'Join a group and follow a multicast stream',
    steps: [
      'Groups and streams belong to an interface: in the model (its `multicast:` block, with `join` and `streams`), or during a simulation from **Join multicast group** and **Start multicast stream** under **Network events** (a host’s menu opens them with the host filled in). Choose the host and its interface (each as *name - address*), write the group (and, for a source-specific group in 232.0.0.0/8, its **Sources**, which appear only then) and, for a stream, its **UDP port**, interval and size; then **Join group** or **Start stream**. The button stays disabled, with the reason under it, until the simulation can carry it out. A stream’s **Interval** is simulated time: its first datagram goes at once, then one every interval (see *Follow the messages: pacing and speed*). Start several: each has its own schedule, its own event and its own traffic (its UDP port, its id in the packet inspector and the event’s details).',
      'The routers elect an IGMP querier per subnet, the hosts report their groups, the switches learn the member ports, and the PIM routers build the tree from the source (through the rendezvous point for any-source groups). The stream’s dots are diamonds and split where it is replicated.',
      '**IGMP / MLD snooping is each switch’s own setting**, chosen per VLAN in its **Edit** tab (**IGMP / MLD snooping**: *Enabled*, *Disabled*, or *Not configured* — an error until you choose; in the file `igmp_mld_snooping`). Enabled, each port of the VLAN has a role for a group: a **member port** (a member of that group reported there), a **multicast router port** (a query or PIM Hello came in there: a multicast router or the VLAN’s querier is behind it — it gets every group, members or not, and is no membership; an uplink or a Layer 3 device behind a port does not make it one), the **ingress port** (never sent back), or none. A group goes to its member ports and the router ports. A group nobody joined (unregistered) goes by the VLAN’s **Unregistered multicast** setting (in the file `unregistered_multicast`): **To the router ports only** (the default, as RFC 4541 requires: nothing to the hosts, and nowhere if the VLAN has no router port) or **Flooded to every port** (which the RFC allows). Disabled (or not configured), multicast is flooded in the VLAN. Reports go to the router ports only, so each switch on the way to the querier learns the port its member’s report came in on — nothing is copied between switches; queries and routing protocols’ link-local groups are always flooded. A membership applies to the very next packet. **Without a querier**, a snooping VLAN learns no router port: a stream stays at the first switch and a member’s report never leaves the switch it reached — give the VLAN a querier (a multicast router, or a switch’s snooping querier). Snooping never routes: on a Layer 3 switch, multicast crosses into another VLAN only with PIM and a member there.',
      '**The querier election** starts by itself with the simulation. Every querier candidate — a router’s interface with IGMP / MLD (its `igmp_querier` on, the default), a switch’s VLAN with the snooping querier on, snooping enabled and an address there — queries at once, taking itself for the querier for now, and sends its **startup queries** (robustness of them, a quarter of the query interval apart). Whoever hears a query from a **lower address** stops: the lowest address of each LAN wins and, once its startup queries are sent, queries every query interval. A non-querier takes over when it hears nothing from the querier for the other querier present interval (robustness × query interval + response interval ÷ 2); a querier powered on again (or its interface back) starts afresh and wins again if its address is lower. Only the queries that reach a candidate count: two LANs with the same VLAN ID elect apart, and a router can be the querier on one interface and not on another. Enabling snooping makes no candidate.',
      '**Every snooping switch shows its role in each VLAN** where its snooping is enabled, always, beside its box: one badge per VLAN, in VLAN order — four VLANs, four badges. Each says the switch’s own part and, apart from it, whether the VLAN has a querier: **★ VLAN 10 · Querier** (it is the elected querier), dashed **☆ VLAN 10 · Querier (startup)** (its startup queries), **◇ VLAN 20 · Standby** (a candidate that yields to another querier), **✕ Candidate down**, **○ VLAN 30 · Snooping · querier heard** (no candidate; a querier queries there) and dashed grey **○ VLAN 40 · Snooping · no querier**, **⏻ Off** or **⏻ Booting** while the switch is powered off or still booting. They follow the protocol — the queries that reach that switch in that VLAN — never the configuration alone, and stay while your events are in front. The tooltip (and a screen reader) gives the details: who the querier is and behind which port, the router ports, where unregistered multicast goes; the switch’s **Show snooping table** lists the same lines. Each badge’s border fits its words; a block keeps its place while the roles change; it sits beside the box where nothing else is drawn. A router marks the **active querier** of each of its LANs beside its status: **Querier · VLAN 10** (several LANs: *VLAN 10, 20*, more: *3 LANs*), dashed **Querier (startup) · VLAN 10** while it sends its startup queries, **Standby · VLAN 10** (grey) for a candidate that yields. The marks follow the election’s state, and the tooltip names the LAN, the interface, the address and the next deadline (*startup query 2 of 2 due at t = 33.3 s*, *it takes over at t = …*). A router candidate configured off or one that is down has no mark; **Show querier election** (a router’s or a switch’s menu) lists every candidacy with its role, the querier it yields to and how long until it would take over. A host’s **Show group memberships** says who queries its LAN (the last query it heard), or that it heard none.',
      '**Members stay members** until they leave: a host that joined answers every query (after a random delay up to the response interval; an IGMPv2 host stays quiet when another member answered first), and its answers keep what the switches and routers learned alive; no second Join is needed. If its answers can’t get through (its cable down), the network forgets it after the membership interval while the host still wants the group, and learns it again from its next answer.',
      '**Leave multicast group** (right below Join multicast group, also in a host’s menu, and the **Leave group** button of its join): choose the host, its interface and one of that interface’s groups (IGMP or MLD by its family; none is chosen for you). Its membership ends at once — no later answer for the group, whatever queries come — and its leave goes out like any report (an IGMPv2 Leave, an IGMPv3 / MLDv2 report that blocks the group), drawn and inspectable. Its event follows what the network had learned on the host’s way: *leave sent · cleanup pending*, then *removed at sw (VLAN 10, port p4)* once the querier’s group-specific queries went unanswered there — exactly robustness × the last member query interval after the leave (2 × 1 s by default); until then the port still gets the group, and a dot’s inspector says *member port, leave pending: it goes in 1.2 s …*; the next datagram after that finds it gone, or *kept … another member there answered* where another member still wants it (one behind the same port, another on the router’s LAN). The stream goes on for the others; only the way to this host closes.',
      'In the private house, start a stream from the **thermostat** (VLAN 20) to 239.20.0.1: dist sends it up to the core (its router port: the core is the snooping querier of VLANs 10, 20 and 30) and the core sends it nowhere, its event says *stops at core*. **Join multicast group** with the **tv** on the same group: now the core sends it towards ap-b and the TV, and nowhere else; leave, and after the last member queries it stops again. The same in VLAN 10: a stream from the **laptop**, then the **nas** joins its group: its report is learned at the core’s port nas and the next datagram reaches it. The TV in VLAN 20 joining the laptop’s group gets nothing: the core routes no multicast between VLANs.',
      '**Why a packet went where it went:** open a multicast dot in the packet inspector. *Switching at dist (sent this hop)* and *Switching at core (where it arrived)* list each port: **→ up: sent — multicast router port (4 min 50 s left)**, **✕ ap1: not sent — no member and no multicast router port**, **✕ ap2: not sent — ingress port**; a Layer 3 switch adds *Routing at core* (its outgoing interfaces, or why none, e.g. it runs no PIM). The snooping table tells router ports (*every group goes there … not a membership*) from member ports (*member port: IGMPv3 …*).',
      'The tables, from a device’s menu, in the simulation panel (they update while they are open): a host’s **Show group memberships** (its own groups, version, filter and what it received; who queries its LAN), a router’s or a switch’s **Show querier election**, a switch’s **Show snooping table** (per VLAN its router ports and each group’s member ports with version, sources, reporter and time left; under it each VLAN’s setting and what it means), a router’s **Show IGMP / MLD groups** (its interfaces’ members, the querier) and **Show multicast routes**. The Status table shows each stream and each member (*Receiving* or *Lost*).',
      'Their packets are drawn like those of **Send network packets**, whatever protocols and senders are ticked (a model without multicast has none to tick): the join’s IGMP / MLD reports from the host’s interface (and what they cause at once: a multicast router’s PIM Join towards the source or RP, its group-specific query after a leave), the stream’s datagrams from its source and each copy the switches and routers make, as far as the simulation forwards them. Where they stop (a router that runs no PIM, a switch whose snooping knows no member and no router port, a VLAN’s end), the stream’s event says so. A dot opens the packet inspector; the event’s **Details** open its first message; the event log marks them **Test**.',
      'Both are listed under **Active events**. A join is *In progress* until a multicast router records the membership (*membership recorded by core1:Vlan10*), or until its reports are sent without any router recording it (*a member on its own segment only*); then it is *Completed*, and the membership stays, with **Leave group**. A stream is *In progress* (*Paused* while the simulation is) until **Stop stream**, which cancels its later datagrams; its line says its interval (*every 1 s of simulated time*), counts the datagrams its source sent (the copies multicast makes are not counted) and, apart from them, those each member received. Its source powered off, it sends nothing (*not sending: srv is off*) until it is up again. A host’s menu also leaves its groups and stops its streams, those of the model too. Fail a link on the tree: the routers’ RPF interfaces change, they join the new way and prune the old, and the members receive again.',
    ],
    notes: ['The election follows RFC 3376 / RFC 3810 (IGMPv2 / v3, MLDv1 / v2): the lowest address wins, the startup queries and the other querier present interval as specified; IGMPv1 is not simulated. All IGMP / MLD timers run on the simulated clock (in Real time pacing it follows real time).', 'The consistency checks report a switch VLAN without a snooping choice (an error), receivers without a querier in their subnet, sparse-mode groups without a rendezvous point, and a router whose route towards a source has no PIM neighbour.', 'A router keeps a member of named sources (an IGMPv3 / MLDv2 join with `sources` in the model) and a member of every source apart on one LAN: while someone there wants every source, every source is forwarded; when that membership ends, only the named sources stay. No group-and-source query is sent. An IPv6 stream goes from its interface’s global address, its MLD messages from the link-local one.', 'Snooping forwards by group: an IGMPv3 / MLDv2 member’s sources are shown in the snooping table but not filtered at the switch. A switch’s snooping querier sends IGMP queries only; IPv6 members are learned from their own reports. Memberships age in simulated time (robustness × query interval + response interval).'],
    figures: [
      ['querier', 'The querier election in the internal example multicast-querier.yaml: q1 (10.5.0.1) is the elected querier of VLAN 10 (its mark beside its status); q2, a candidate with a higher address, is on standby.'],
      ['mroutes', 'r1’s multicast routes in the simulation panel: the RP, the shared tree (*, 239.1.1.1) and the sources’ trees, each with its incoming and outgoing interfaces.'],
    ],
  },
  {
    id: 'sim-apps',
    title: 'Start applications and follow MQTT',
    steps: [
      'Applications send nothing by themselves. In **Network events**, open **Start application**, choose a **Device** (a device with only listeners is listed as *listeners only*) and its **Application**, and press **Start application**. One with **Starts** *With the simulation* starts by itself 3 s after the simulation does — or, when its device is not operational then (booting, powered off, a guest waiting for its host), 3 s after the device has booted; meanwhile its status says *Waiting*. It starts once: a run of it still going on is not started again, also not after a reboot; a configuration problem is said and not tried again.',
      'A client connects, sends its request and waits for the answer, with its timeout and retries; a periodic sender repeats every interval of simulated time, its count or until stopped. **Active events** shows each start as one entry with what each message came to — one outcome per message, from its last attempt (sent, or not sent because its device was off); its retries are counted apart — and its **Stop**. Stop works as long as the run is active, also while its last message is still on its way (waiting for its address, its neighbor, its connection or its answer): nothing more is sent and no retry follows; what is already on its way finishes.',
      'In ot-network.yaml start hmi-1’s *Temperatures* and plc-1’s *Telemetry*: the PLC connects to edge-1, the broker, and publishes its temperature and its pressure every 5 s; the broker forwards the temperature to the HMI (its filter *plant/cell1/+/temperature*) and the pressure to nobody. eng-ws’s *Alarm log* subscribes to a filter nothing matches and receives nothing.',
      'On the broker, **Show MQTT sessions** lists its clients and their subscriptions; on a client, **Show MQTT clients** its state, publications and what it received by topic. A message’s dot opens its inspection: its type, topic, QoS and packet id, and its payload’s size, never its contents.',
    ],
    notes: ['MQTT 3.1.1 with clean sessions: QoS 0 and 1 (no QoS 2), keep-alives, a reconnect after a lost connection (every 5 s), UNSUBSCRIBE and DISCONNECT when stopped. A periodic publisher keeps its schedule across a lost connection: a publication that falls while it is not connected is not sent (nor counted toward its number of messages), the next one is once it is connected again. Packet identifiers run from 1 to 65535 and skip those still waiting for their acknowledgment; topics, filters and client identifiers count in UTF-8 bytes. Every message goes through the broker over TCP; nothing is IP multicast.'],
  },
  {
    id: 'sim-time',
    title: 'Follow time synchronization: NTP and PTP',
    steps: [
      '**NTP**: a device with a stratum serves time as a reference. One with upstreams is *Unsynchronized* (stratum 16) until an upstream answered, then *Synchronized* to it at one stratum more; after 8 unanswered polls it is unsynchronized again. **Show NTP status** lists its upstreams, their last answer and its source. No offset is computed.',
      '**PTP**: give each clock the **PTP** service — its **Clock function** (ordinary, boundary, transparent), the one **Profile** (IEEE 1588-2008 Default, E2E, UDP/IPv4, two-step), its **Domain**, its **Interfaces** and, for an ordinary clock, its **Role** (may become the grandmaster, or receiver only). The data set (priorities, clock class), the intervals, the clock’s offset and drift and the timestamping are in **Advanced**.',
      'Start a simulation: the clocks elect the grandmaster from their Announces, and the slaves measure offset and path delay with Sync, Follow_Up, Delay_Req and Delay_Resp. Each clock gets a mark on its box: **★ PTP · Grandmaster**, **✓ PTP · Synchronized**, **PTP · Acquiring** (dashed: its servo not locked yet; *Listening*: no master heard yet), **✕ PTP · Holdover** or **✕ PTP · Unsynchronized** (dotted: no Sync, or no master), **PTP · Transparent clock** (never a source). Its tooltip says why; **Show PTP clock** lists its ports and their states, data sets, grandmaster, last offset and path delay.',
      'In timing-ptp.yaml, gm-a is the grandmaster through the transparent clock sw-a and the boundary clock rt. **Power off** gm-a: after three missed Announces gm-b takes over, and rt and the receivers follow; **Power on** gm-a: it wins again.',
    ],
    notes: ['A clock is *Synchronized* after three offsets in a row below 1 µs (hardware timestamps) or 100 µs (software): the model’s rule, not a guaranteed accuracy. Every clock is a modelled local clock beside the simulation’s time, which it never moves. Holdover quality, one-step clocks, peer delay, gPTP and TSN are not modelled; NTP and PTP never discipline each other.'],
    figures: [['ptp', 'Cell A of timing-ptp.yaml in a simulation: gm-a the grandmaster, gm-b synchronized to it, sw-a the transparent clock between them.']],
  },
  {
    id: 'sim-broadcast',
    title: 'See a broadcast domain and a broadcast storm',
    steps: [
      'During a simulation, click a device or a cable and choose **Highlight broadcast domain** (for a device with several interfaces, or a cable with several VLANs, choose one). The devices, ports and cables a broadcast reaches from there are marked, the rest dimmed; routers end it. Choose **Clear broadcast domain highlight** to remove it.',
      'A loop of switches whose **Spanning tree** is **Off** (Layer 2, or a switch’s Simulation section) storms: the first broadcast comes back, circulates and multiplies. The banner and the simulation panel warn; the event log shows the storm and MAC addresses moving between ports.',
      'End it by failing one of the loop’s cables or setting the spanning tree back on. **Storm control** on a switch (its Simulation section) drops the looping frames at its ports.',
    ],
    figures: [['bc-domain', 'Highlight broadcast domain from the lab host: its switches, ports and cables marked, both cables between the switches among them (their spanning tree is off).']],
  },
  {
    id: 'sim-fail',
    title: 'Fail links, flap, shut and power off',
    steps: [
      'During a simulation, click a cable for **Fail link**, a relation for **Fail link**, a device for **Power off** or **Shut an interface…**, an interface for **Shut interface** or **Start flapping**. Flapping is an interface’s action, never a cable’s: the port goes down and up, its cable with it, while the port stays administratively up (a cable’s menu has no flapping, and the simulation refuses a cable as its target). Or open **Interface actions** under **Network events** in the **Actions** panel: choose the device and its interface, then **Shut interface** or **Start flapping**. The form shows the interface’s state, whatever changed it: shut, it is marked *⏻ Shut: administratively down* and its button is **Bring interface up**; flapping, it is marked *↯ Flapping* with the cycle and its button is **Stop flapping**. The state says the administrative state and the link apart: after **Bring interface up** the interface is administratively up, but its link stays down while something else holds it (*link down (dsl-router is off)*). A button that doesn’t apply is disabled and the line under it says why (no cable; shut: bring it up first). **Shut interface** while it flaps stops the flapping first, so no flap transition scheduled before can bring it up again. **Stop flapping** cancels the flap’s later transitions and leaves the cable as it would be without the flapping: up again, unless a shut, a failed cable or a device off holds it down. One flapping per cable (from one of its ends: the other end’s form says so); a shut interface doesn’t flap; a port with `simulation: {flapping: "on"}` flaps from the start. Flapping follows the Layer 1 parameters (down 5 s, up 10 s, 3 cycles by default), shown in the form. Several events can be in effect at once.',
      'Watch the reaction: frames on a cable that went down are lost (✕), its ports notice after the loss-of-signal detection time, others when their timers run out (OSPF’s dead interval, BGP’s hold time, BFD), adjacencies go down, routes are recomputed after the route recomputation delay and traffic takes another way, or is lost.',
      '**Every device’s status in the diagram.** While a simulation runs, each device has a small status indicator on its box’s edge: an LED and a word. **Operational** (a green LED): powered on and booted. **Powered off** (red, a red frame; the box gets a dotted red outline). **Booting** (blue, dashed) after **Power on**, until its boot time is over, then *Operational* again. An external network says **External**, a patch panel, a TAP or a pass-through **Passive** (a hollow grey LED): they have no power state of their own and no **Power off**; *Unknown* would mean the simulation has no state for it. The indicator sits on the top edge where nothing else is drawn (else the bottom edge): no name, address, port, cable or other indicator under it, and the box never moves or resizes. Its tooltip and the device’s menu say the state with its time (*Powered off at t = 12 s (down with its host esx-02)*, *Booting: powered on, up at t = 45 s*); the diagram’s accessible name lists the devices powered off or booting; the **Legend** tab explains the colours. It is the state the simulation forwards by: a device off or booting takes no part. Only the device itself counts: a shut interface, a cable down, a peer away, a blocked packet or an unreachable destination never mark a device off, and *Operational* doesn’t promise that its interfaces, services or destinations are reachable. Exiting the simulation removes the indicators; opening another model clears every state.',
      '**Active events** in the Actions panel lists them all with their way back: **Restore**, **Stop flapping**, **No shut**, **Power on** (the device boots for its boot time, then starts afresh). A shut is *Completed* at once and shows *interface down (shut)* until **No shut**; flapping is *In progress* with its cycles until they are done or stopped. Adjacencies form again with their full handshake.',
      'Each event of Network events shows its state as an icon and a word: *Queued* (accepted, nothing sent yet, e.g. a DHCP client waiting for its lease), *In progress*, *Paused* (a stream while the simulation is paused), *Completed* (finished; how it went is its outcome, not its state), *Failed* (the simulation refused it, or none of its messages could be sent), *Stopped* or *Cancelled* (stopped before anything was sent). A send shows *sent of requested* as a bar and its outcome: answered, failed, pending (never counted as failed), and for a broadcast *unanswered (receipt unknown)*. The success rate is shown only where it means something: unicast (an answer), multicast (received by at least one member); a broadcast without an answer may still have arrived. **Details** has the basis, the messages and **Inspect the first message**. Finished events stay (up to 50); **Clear finished** removes them; exiting the simulation discards them all.',
    ],
    figures: [['device-state', 'Every device’s status during a simulation: lab-h Powered off (a red LED and frame, a dotted outline), lab-sw2 Booting after Power on (blue, dashed), the others Operational (a green LED); each indicator’s tooltip says the state with its time.']],
  },
  {
    id: 'trace',
    title: 'Check a communication',
    steps: [
      'Press `T` or choose **Analyze → Communication**. **From** and **To** search the model as you type — devices, interfaces, exact addresses, applications (`hmi/poll`), services (`ntp1/ntp`) and host names — and say how each binds: an **exact address**, an **interface’s effective address**, an **application’s configured peer** (a client application with **To** empty) or a **host name resolved when sent**. **Service** (tcp/443, udp/53, icmp) comes from the application or service when there is one. **Advanced options**: the **VRF**, the **Family** (**Automatic family**: the ends’ own, one family evaluated) and the return direction. **Check communication** (or `Enter`) asks.',
      '**Analyze → Diagnose selected communication** (`Shift+D`) asks about the selection at once: a device’s one client application (to its peer or broker), a device or interface as the source, or a relation between its ends. A device with several client applications asks which first; a new question keeps nothing of the one before it.',
      'The **Answer** comes once — **Established**, **Blocked**, **Not completed — cause not established**, **Waiting**, **In progress**, **Recovered**, **Partial**, **Cancelled** or **Not established** — with what was evaluated. Then the next steps, **What is established** layer by layer (addresses, name resolution, network path, policy, destination listener), the **Main blocker or limitation** (each cause once, with its messages), the **Runtime observation** when one is attached, and the paths, the path MTU and the evidence chain. **Runtime limitation** is what static analysis never establishes (a session, an application’s answer), not a failed layer.',
      'The evidence shown first is an established blocker, else what needs attention, else the main path. **Evidence** beside a layer or a blocker, **Why?** beside a hop (the lookup, the route that won and why, the alternatives, the layer-2 way, the policy, the tunnel, where it stops) and a policy link (the rules as diagnosed, the deciding one marked) show it on the right; a packet, message or event opens in the packet inspector. A record no longer kept, or of an earlier simulation, is said unavailable.',
      'Next steps: **Inspect deciding rule**, **Inspect limiting interface**, **Prepare modeled test** (Network events filled in with the same communication; nothing is sent until you press Send), **Compare matching observation** (the newest recorded run of exactly this communication — a client application’s own run, never a send prepared like it; an MQTT client’s own publications), **Prepare MTU test**, **Save as requirement…** and **Use in experiment…**.',
      'The path is marked in the diagram (alternatives dashed, the return path dotted). **Copy as text** and **Save as text** carry the question, the answer, its evidence, the context, the version and the model’s fingerprint. **Clear** or `Esc` in the diagram removes the path; the result stays for when you come back.',
    ],
    notes: [
      'Computed from the model’s routes, adjacencies, policies (written, a firewall’s implicit one, a Security gateway’s), VPN tunnels, paired ports and listeners: an approximation, not a simulation of the protocols. A listener establishes a consistent configuration, not that the application answers; an MTU the model does not write is never taken as known. Guests leave their host by their virtual switch’s uplink (or a passthrough port); container bridges translate addresses (**SNAT**, **DNAT**). Nothing in the model changes.',
    ],
    figures: [['trace', 'Communication from the Munich branch to the syslog server: the answer and what is established at the bottom, a hop’s decision evidence on the right, both equal-cost paths in the diagram.']],
  },
  {
    id: 'addressing',
    title: 'See the addressing',
    steps: [
      'Choose **Analyze → Addressing** (or press `I`). The results list the networks of each VRF, the default table first, each under the network that contains it: **prefix**, **VLAN**, **name**, **gateway or VIP**, **hosts** in use, how much is **allocated** (configured, reserved, acquired, DHCP pool, nested networks: each address counted once), the **next unallocated** address and the ranges **unallocated in model**. While a simulation runs it can read a snapshot: the addresses DHCP, SLAAC and DHCPv6 gave.',
      'Filter by words, and choose what to show: **All networks**, **Conflicts** (an address used twice in one scope — confirmed where the model puts the owners in one scope, possible where a scope is not known — and the reuse the model separates, which is legitimate), **Overlaps**, or **Outside declared networks**.',
      'Select a network (its row) or an issue: its members, pools and reservations, allocation and unallocated ranges, or the conflict’s owners and why, are in the evidence panel. **▸ members** still opens a row’s members in place. **Copy CSV** and **Save CSV** give the table with its allocation and context.',
    ],
    notes: [
      'Unallocated in the model is not free in the real network: an address outside NetAtlas may still be in use. When you add an address in the Edit tab, **Next free address** offers the lowest address unallocated in the model of a network of the interface’s VRF (never in a DHCP pool or reserved).',
    ],
    figures: [['addressing', 'Addressing of a model with many kinds of address: the networks with nested prefixes, gateways and VIPs and their allocation, one network’s members and unallocated ranges in the evidence panel.']],
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
      '**Auto-arrange** in the toolbar lays out the whole model in the view on screen, in one of three ways. The other view is not changed.',
      '**Default** (`A`) is the balanced layout every model starts with: devices in rows by tier, groups placed by their cabling, each row ordered to keep cables short and uncrossed. A cable that has to go around a device takes the side that crosses no other cable when there is one.',
      '**Compact** packs the same rows tighter: less empty space inside and between groups, long rows of leaf devices (the clients under a switch) folded onto a second line, and unconnected groups side by side. Nothing is made smaller and nothing overlaps; where Default is already tight, Compact gives the same positions.',
      '**Structured** puts devices on a grid in rows and columns, each aligned with what it is connected to, and draws every cable and relation with horizontal and vertical lines and right-angle bends only. Lines that share a corridor run side by side, never on top of each other.',
      'The option the view is arranged with is highlighted. If you moved objects by hand, NetAtlas asks before replacing their positions; `Ctrl+Z` undoes the arrangement (positions and line style together).',
      'Drag a device or network to move it. Its position is saved in the model, except in a filtered view. After **Structured**, a moved object’s lines are routed again, still at right angles, and nothing else is rearranged. **Default** or **Compact** brings back the standard lines.',
    ],
    notes: ['Some cabling (two spines to four leaves, a ring) can’t be drawn without crossings in any of the three.'],
    figures: [
      ['toolbar-groups', 'The View, Auto-arrange and Filters groups of the toolbar.'],
      ['arrange-structured', 'The private house arranged with Structured: rows and columns, every line horizontal or vertical.'],
    ],
  },
];

const SHORTCUTS: Array<[string, string]> = [
  ['P / L', 'Physical / Logical view (also 1 / 2)'],
  ['/', 'Find in diagram'],
  ['Ctrl+S / Ctrl+Shift+S', 'Save model / Save model as'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
  ['C', 'Connect the selected object'],
  ['I', 'Analyze → Addressing'],
  ['Ctrl+K', 'Command palette (Cmd+K on a Mac)'],
  ['Shift+F', 'Focus on the selection, in the Focus window (Esc in the diagram exits)'],
  ['T', 'Analyze → Communication (Esc in the diagram removes the path)'],
  ['Shift+D', 'Analyze → Diagnose selected communication: the question from the selection, checked at once'],
  ['F6 / Shift+F6', 'The next / previous part: left panel, diagram, right panel, bottom panel, tool window'],
  ['Ctrl+K → enable', 'Enable a protocol on the selected device'],
  ['A', 'Auto-arrange: Default'],
  ['+ / − / 0', 'Zoom in / out / fit (also F)'],
  ['Esc', 'Clear the selection, cancel, close a tool window; in Analyze: cancel an editor, then let the evidence go; in the diagram: end a path or focus, then leave Analyze, Experiments or a simulation'],
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

const SUPPORT_TITLE = 'What NetAtlas models';

/**
 * The support catalog (model/support-catalog.ts) as a section: what each
 * static analysis evaluates, and each protocol's, service's and application
 * profile's level, what it does and what it leaves out — the same
 * statements as the ⓘ notes and docs/SUPPORT.md.
 */
function supportSection(doc: Document): HTMLElement {
  const sec = el(doc, 'section', { class: 'man-sec', id: 'man-support', 'aria-labelledby': 'man-h-support' });
  sec.appendChild(el(doc, 'h3', { id: 'man-h-support', tabindex: '-1' }, [SUPPORT_TITLE]));
  sec.appendChild(el(doc, 'p', {}, ['Each protocol, service and application profile says what the simulation does for it, at one of three levels: **Diagram only**, **Configuration and validation**, **Modeled behavior** (within the stated limits; never “full support”). The static analyses evaluate the configured model or a snapshot and send nothing. The same statements are shown by the ⓘ notes in the editor and in Start simulation.'].flatMap((t) => rich(doc, t))));
  const table = (rows: Array<[string, string, string, string]>, withLevel: boolean): HTMLElement =>
    el(doc, 'table', { class: 'man-support' }, [
      el(doc, 'thead', {}, [el(doc, 'tr', {}, (withLevel ? ['Name', 'Level', 'Implemented', 'Not modeled'] : ['Analysis', 'Evaluates', 'Does not establish']).map((h) => el(doc, 'th', { scope: 'col' }, [h])))]),
      el(doc, 'tbody', {}, rows.map((r) => el(doc, 'tr', {}, [el(doc, 'th', { scope: 'row' }, [r[0]])].concat((withLevel ? [r[1], r[2], r[3]] : [r[2], r[3]]).map((c) => el(doc, 'td', {}, [c])))))),
    ]);
  const group = (title: string, body: HTMLElement): HTMLElement => el(doc, 'details', { class: 'man-support-area' }, [el(doc, 'summary', {}, [title]), body]);
  sec.appendChild(group('Static analysis (Analyze)', table(ANALYSIS_SUPPORT.map((a) => [a.name, '', a.does, a.not] as [string, string, string, string]), false)));
  const cat = supportCatalog();
  for (const area of supportAreas()) sec.appendChild(group(area, table(cat.filter((e) => e.area === area).map((e) => [e.name, supportLabel(e.support.level), e.support.does, e.support.not] as [string, string, string, string]), true)));
  return sec;
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
  for (const s of MANUAL.concat([{ id: 'support', title: SUPPORT_TITLE }, { id: 'keys', title: 'Keyboard shortcuts' }])) {
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
  wrap.appendChild(supportSection(doc));
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
