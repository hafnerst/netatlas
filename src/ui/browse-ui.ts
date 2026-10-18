/**
 * The Applications, VLANs and VRFs window (Find → Applications, VLANs and
 * VRFs…): navigation by context in a larger model. Each entry has Focus
 * (the contextual focus of Analyze → Focus: the devices it involves) and,
 * for an application, Select. Configured structure; nothing is changed.
 */
import { navigationIndex } from '../analysis/focus';
import { el } from './dom';

export interface BrowseActions {
  focusApp(device: string): void;
  selectApp(device: string): void;
  focusVlan(vlan: number): void;
  focusVrf(vrf: string): void;
}

export function browseBody(doc: Document, nav: ReturnType<typeof navigationIndex>, act: BrowseActions): HTMLElement {
  const box = el(doc, 'div', { class: 'browse-win' });
  box.appendChild(el(doc, 'p', { class: 'muted small' }, ['Focus shows the devices an application, VLAN or VRF involves (as configured); Exit focus (Esc) shows the complete diagram again.']));
  const section = (title: string, id: string, n: number, rows: HTMLElement[]): void => {
    const d = el(doc, 'details', { class: 'layer-ev', id, open: '' }, [el(doc, 'summary', {}, [`${title} (${n})`])]);
    if (!rows.length) d.appendChild(el(doc, 'p', { class: 'muted small' }, ['None in this model.']));
    else d.appendChild(el(doc, 'ul', { class: 'vw-list' }, rows));
    box.appendChild(d);
  };
  const btn = (label: string, attrs: { [k: string]: string }, f: () => void): HTMLElement => {
    const b = el(doc, 'button', { type: 'button', ...attrs }, [label]);
    b.addEventListener('click', f);
    return b;
  };
  const LIMIT = 300;
  section('Applications', 'nav-apps', nav.apps.length, nav.apps.slice(0, LIMIT).map((a) => el(doc, 'li', { 'data-nav-app': `${a.device}/${a.app}` }, [el(doc, 'strong', {}, [a.name]), ' ', el(doc, 'span', { class: 'muted small' }, [`${a.device}/${a.app}`]), el(doc, 'span', { class: 'vw-tools' }, [btn('Select', { 'data-nav': 'select', title: `Select ${a.device}` }, () => act.selectApp(a.device)), btn('Focus', { 'data-nav': 'focus', title: `Show ${a.device} and what its applications and services depend on` }, () => act.focusApp(a.device))])])));
  section('VLANs', 'nav-vlans', nav.vlans.length, nav.vlans.slice(0, LIMIT).map((v) => el(doc, 'li', { 'data-nav-vlan': String(v.vlan) }, [el(doc, 'strong', {}, [`VLAN ${v.vlan}`]), ' ', el(doc, 'span', { class: 'muted small' }, [`${v.name ? v.name + ' · ' : ''}${v.devices} device${v.devices === 1 ? '' : 's'}`]), el(doc, 'span', { class: 'vw-tools' }, [btn('Focus', { 'data-nav': 'focus', title: `Show the devices of VLAN ${v.vlan}` }, () => act.focusVlan(v.vlan))])])));
  section('VRFs', 'nav-vrfs', nav.vrfs.length, nav.vrfs.slice(0, LIMIT).map((v) => el(doc, 'li', { 'data-nav-vrf': v.vrf }, [el(doc, 'strong', {}, [`VRF ${v.vrf}`]), ' ', el(doc, 'span', { class: 'muted small' }, [`${v.devices.length} device${v.devices.length === 1 ? '' : 's'}: ${v.devices.slice(0, 6).join(', ')}${v.devices.length > 6 ? ' …' : ''}`]), el(doc, 'span', { class: 'vw-tools' }, [btn('Focus', { 'data-nav': 'focus', title: `Show the devices with an interface in VRF ${v.vrf}` }, () => act.focusVrf(v.vrf))])])));
  const over = [nav.apps.length, nav.vlans.length, nav.vrfs.length].some((n) => n > LIMIT);
  if (over) box.appendChild(el(doc, 'p', { class: 'muted small' }, [`The first ${LIMIT} of each are listed; Find in diagram (/) finds the others.`]));
  return box;
}
