import type { TemplateResult } from 'lit';
import { html } from 'lit';
import { customElement } from 'lit/decorators.js';

import { BumperElement } from '../../utils/base.utils.js';

@customElement('bumper-app')
export class BumperApp extends BumperElement {
  protected override render(): TemplateResult {
    return html`<p class="wa-body-m">bumper manage — loading…</p>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'bumper-app': BumperApp;
  }
}
