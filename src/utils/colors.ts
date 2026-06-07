export const ESC = '\x1b[';
export const RESET = `${ESC}0m`;

export const styles = {
  bold: '1',
  dim: '2',
  italic: '3',
  underline: '4',
  
  // Foreground colors
  black: '30',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  white: '37',
  gray: '90',
  
  // Background colors
  bgBlack: '40',
  bgRed: '41',
  bgGreen: '42',
  bgYellow: '43',
  bgBlue: '44',
  bgMagenta: '45',
  bgCyan: '46',
  bgWhite: '47',
};

function format(styleCode: string, text: string): string {
  return `${ESC}${styleCode}m${text}${RESET}`;
}

export const bold = (txt: string) => format(styles.bold, txt);
export const dim = (txt: string) => format(styles.dim, txt);
export const italic = (txt: string) => format(styles.italic, txt);
export const underline = (txt: string) => format(styles.underline, txt);

export const red = (txt: string) => format(styles.red, txt);
export const green = (txt: string) => format(styles.green, txt);
export const yellow = (txt: string) => format(styles.yellow, txt);
export const blue = (txt: string) => format(styles.blue, txt);
export const magenta = (txt: string) => format(styles.magenta, txt);
export const cyan = (txt: string) => format(styles.cyan, txt);
export const white = (txt: string) => format(styles.white, txt);
export const gray = (txt: string) => format(styles.gray, txt);

export const bgRed = (txt: string) => format(styles.bgRed, txt);
export const bgGreen = (txt: string) => format(styles.bgGreen, txt);
export const bgBlue = (txt: string) => format(styles.bgBlue, txt);
export const bgCyan = (txt: string) => format(styles.bgCyan, txt);

export const success = (txt: string) => `${green('✓')} ${txt}`;
export const warning = (txt: string) => `${yellow('⚠')} ${txt}`;
export const info = (txt: string) => `${cyan('ℹ')} ${txt}`;
export const failure = (txt: string) => `${red('❌')} ${txt}`;
