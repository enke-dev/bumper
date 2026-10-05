/** A run of text with the CSS classes its SGR state maps to. */
export interface AnsiSpan {
  text: string;
  classes: string[];
}

// built from the code point: a literal control character in a regex trips the linter
const ESC = String.fromCharCode(0x1b);
const ESCAPE = new RegExp(`${ESC}\\[([0-9;]*)m`, 'g');
const CLEAR = new RegExp(`${ESC}\\[[0-9;]*[A-LN-Za-ln-z]|\\r`, 'g');

interface Style {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  fg: number | null;
}

const RESET: Style = { bold: false, dim: false, italic: false, underline: false, fg: null };

/** Apply one SGR parameter list to a style. */
function apply(style: Style, codes: number[]): Style {
  return codes.reduce<Style>((current, code, index, all) => {
    if (code === 0) {
      return { ...RESET };
    }
    if (code === 1) {
      return { ...current, bold: true };
    }
    if (code === 2) {
      return { ...current, dim: true };
    }
    if (code === 3) {
      return { ...current, italic: true };
    }
    if (code === 4) {
      return { ...current, underline: true };
    }
    if (code === 22) {
      return { ...current, bold: false, dim: false };
    }
    if (code === 23) {
      return { ...current, italic: false };
    }
    if (code === 24) {
      return { ...current, underline: false };
    }
    if (code === 39) {
      return { ...current, fg: null };
    }
    if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      return { ...current, fg: code };
    }
    // 256/true colour: consume the parameters, keep the default colour
    if (code === 38 && all[index + 1] === 5) {
      return { ...current, fg: null };
    }
    return current;
  }, style);
}

function classesOf(style: Style): string[] {
  return [
    style.bold ? 'ansi-bold' : '',
    style.dim ? 'ansi-dim' : '',
    style.italic ? 'ansi-italic' : '',
    style.underline ? 'ansi-underline' : '',
    style.fg !== null ? `ansi-fg-${style.fg}` : '',
  ].filter(Boolean);
}

/** Split one output line into styled spans; cursor/clear sequences and `\r` are dropped. */
export function parseAnsi(line: string): AnsiSpan[] {
  const clean = line.replace(CLEAR, '');
  const parts = clean.split(ESCAPE);
  // split() yields [text, codes, text, codes, text …]
  const result = parts.reduce<{ style: Style; spans: AnsiSpan[] }>(
    (acc, part, index) => {
      if (index % 2 === 1) {
        const codes = part === '' ? [0] : part.split(';').map(Number);
        return { ...acc, style: apply(acc.style, codes) };
      }
      return part === ''
        ? acc
        : { ...acc, spans: [...acc.spans, { text: part, classes: classesOf(acc.style) }] };
    },
    { style: { ...RESET }, spans: [] }
  );
  return result.spans;
}
