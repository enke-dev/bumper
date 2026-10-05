import type { CSSResultGroup } from 'lit';
import { css, LitElement, unsafeCSS } from 'lit';

import utilities from '@awesome.me/webawesome/dist/styles/utilities.css?inline';

const UTILITIES = unsafeCSS(utilities);

/** Shared host defaults: components are block-level and honour `hidden`. */
const BASE = css`
  :host {
    display: block;
  }
  :host([hidden]) {
    display: none;
  }
`;

/**
 * Base class for every bumper element. `withStyles()` appends component styles; `withUtilities()`
 * opts the shadow root into Web Awesome's utility classes (`wa-stack`, `wa-cluster`, `wa-gap-*`…),
 * which don't pierce shadow DOM on their own. Both compose: `BumperElement.withUtilities().withStyles(styles)`.
 */
export class BumperElement extends LitElement {
  static override styles: CSSResultGroup = [BASE];

  static withStyles<T extends typeof BumperElement>(this: T, ...additional: CSSResultGroup[]): T {
    const Base = this as typeof BumperElement;
    return class extends Base {
      static override styles = [Base.styles, ...additional];
    } as unknown as T;
  }

  static withUtilities<T extends typeof BumperElement>(this: T): T {
    return (this as typeof BumperElement).withStyles(UTILITIES) as unknown as T;
  }
}
