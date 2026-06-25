class ColorText {
// Standard 8/16 colors
static black(text) {
  return `\x1b[30m${text}\x1b[0m`;
}

static red(text) {
  return `\x1b[31m${text}\x1b[0m`;
}

static green(text) {
  return `\x1b[32m${text}\x1b[0m`;
}

static yellow(text) {
  return `\x1b[33m${text}\x1b[0m`;
}

static blue(text) {
  return `\x1b[34m${text}\x1b[0m`;
}

static magenta(text) {
  return `\x1b[35m${text}\x1b[0m`;
}

static cyan(text) {
  return `\x1b[36m${text}\x1b[0m`;
}

static white(text) {
  return `\x1b[37m${text}\x1b[0m`;
}

// Bright/Vivid versions (90-97)
static brightBlack(text) {
  return `\x1b[90m${text}\x1b[0m`;
}

static brightRed(text) {
  return `\x1b[91m${text}\x1b[0m`;
}

static brightGreen(text) {
  return `\x1b[92m${text}\x1b[0m`;
}

static brightYellow(text) {
  return `\x1b[93m${text}\x1b[0m`;
}

static brightBlue(text) {
  return `\x1b[94m${text}\x1b[0m`;
}

static brightMagenta(text) {
  return `\x1b[95m${text}\x1b[0m`;
}

static brightCyan(text) {
  return `\x1b[96m${text}\x1b[0m`;
}

static brightWhite(text) {
  return `\x1b[97m${text}\x1b[0m`;
}

// 256-color palette - Common colors
static orange(text) {
  return `\x1b[38;5;208m${text}\x1b[0m`;
}

static pink(text) {
  return `\x1b[38;5;205m${text}\x1b[0m`;
}

static purple(text) {
  return `\x1b[38;5;129m${text}\x1b[0m`;
}

static brown(text) {
  return `\x1b[38;5;130m${text}\x1b[0m`;
}

static lime(text) {
  return `\x1b[38;5;154m${text}\x1b[0m`;
}

static teal(text) {
  return `\x1b[38;5;30m${text}\x1b[0m`;
}

static lavender(text) {
  return `\x1b[38;5;183m${text}\x1b[0m`;
}

static salmon(text) {
  return `\x1b[38;5;209m${text}\x1b[0m`;
}

static gold(text) {
  return `\x1b[38;5;220m${text}\x1b[0m`;
}

static silver(text) {
  return `\x1b[38;5;7m${text}\x1b[0m`;
}

// Background colors (standard)
static bgBlack(text) {
  return `\x1b[40m${text}\x1b[0m`;
}

static bgRed(text) {
  return `\x1b[41m${text}\x1b[0m`;
}

static bgGreen(text) {
  return `\x1b[42m${text}\x1b[0m`;
}

static bgYellow(text) {
  return `\x1b[43m${text}\x1b[0m`;
}

static bgBlue(text) {
  return `\x1b[44m${text}\x1b[0m`;
}

static bgMagenta(text) {
  return `\x1b[45m${text}\x1b[0m`;
}

static bgCyan(text) {
  return `\x1b[46m${text}\x1b[0m`;
}

static bgWhite(text) {
  return `\x1b[47m${text}\x1b[0m`;
}

// Bright background colors
static bgBrightBlack(text) {
  return `\x1b[100m${text}\x1b[0m`;
}

static bgBrightRed(text) {
  return `\x1b[101m${text}\x1b[0m`;
}

static bgBrightGreen(text) {
  return `\x1b[102m${text}\x1b[0m`;
}

static bgBrightYellow(text) {
  return `\x1b[103m${text}\x1b[0m`;
}

static bgBrightBlue(text) {
  return `\x1b[104m${text}\x1b[0m`;
}

static bgBrightMagenta(text) {
  return `\x1b[105m${text}\x1b[0m`;
}

static bgBrightCyan(text) {
  return `\x1b[106m${text}\x1b[0m`;
}

static bgBrightWhite(text) {
  return `\x1b[107m${text}\x1b[0m`;
}

// Text styles
static bold(text) {
  return `\x1b[1m${text}\x1b[0m`;
}

static dim(text) {
  return `\x1b[2m${text}\x1b[0m`;
}

static italic(text) {
  return `\x1b[3m${text}\x1b[0m`;
}

static underline(text) {
  return `\x1b[4m${text}\x1b[0m`;
}

static blink(text) {
  return `\x1b[5m${text}\x1b[0m`;
}

static inverse(text) {
  return `\x1b[7m${text}\x1b[0m`;
}

static hidden(text) {
  return `\x1b[8m${text}\x1b[0m`;
}

static strikethrough(text) {
  return `\x1b[9m${text}\x1b[0m`;
}

// Utility methods
static custom(text, colorCode) {
  if (colorCode >= 0 && colorCode <= 255) {
    return `\x1b[38;5;${colorCode}m${text}\x1b[0m`;
  }
  return text;
}

static bgCustom(text, colorCode) {
  if (colorCode >= 0 && colorCode <= 255) {
    return `\x1b[48;5;${colorCode}m${text}\x1b[0m`;
  }
  return text;
}

static rgb(text, r, g, b) {
  if (r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255) {
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
  }
  return text;
}

static bgRgb(text, r, g, b) {
  if (r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255) {
    return `\x1b[48;2;${r};${g};${b}m${text}\x1b[0m`;
  }
  return text;
}

static combine(text, ...styles) {
  let result = text;
  for (const style of styles) {
    if (typeof style === 'function') {
      result = style(result);
    } else if (typeof style === 'string') {
      // Handle string style names
      const styleMethod = this[style] || this[style.toLowerCase()];
      if (styleMethod) {
        result = styleMethod.call(this, result);
      }
    }
  }
  return result;
}

/**
 * Display all available colors with examples
 * @param {string} sampleText - Text to display for each color
 * @param {boolean} showCode - Whether to show the ANSI code
 */
static showAllColors(sampleText = "Hello World", showCode = true) {
  const colorGroups = {
    "Standard Colors": [
      { name: "black", method: this.black },
      { name: "red", method: this.red },
      { name: "green", method: this.green },
      { name: "yellow", method: this.yellow },
      { name: "blue", method: this.blue },
      { name: "magenta", method: this.magenta },
      { name: "cyan", method: this.cyan },
      { name: "white", method: this.white }
    ],
    "Bright Colors": [
      { name: "brightBlack", method: this.brightBlack },
      { name: "brightRed", method: this.brightRed },
      { name: "brightGreen", method: this.brightGreen },
      { name: "brightYellow", method: this.brightYellow },
      { name: "brightBlue", method: this.brightBlue },
      { name: "brightMagenta", method: this.brightMagenta },
      { name: "brightCyan", method: this.brightCyan },
      { name: "brightWhite", method: this.brightWhite }
    ],
    "256-Color Palette": [
      { name: "orange", method: this.orange },
      { name: "pink", method: this.pink },
      { name: "purple", method: this.purple },
      { name: "brown", method: this.brown },
      { name: "lime", method: this.lime },
      { name: "teal", method: this.teal },
      { name: "lavender", method: this.lavender },
      { name: "salmon", method: this.salmon },
      { name: "gold", method: this.gold },
      { name: "silver", method: this.silver }
    ],
    "Background Colors": [
      { name: "bgBlack", method: this.bgBlack },
      { name: "bgRed", method: this.bgRed },
      { name: "bgGreen", method: this.bgGreen },
      { name: "bgYellow", method: this.bgYellow },
      { name: "bgBlue", method: this.bgBlue },
      { name: "bgMagenta", method: this.bgMagenta },
      { name: "bgCyan", method: this.bgCyan },
      { name: "bgWhite", method: this.bgWhite }
    ],
    "Bright Backgrounds": [
      { name: "bgBrightBlack", method: this.bgBrightBlack },
      { name: "bgBrightRed", method: this.bgBrightRed },
      { name: "bgBrightGreen", method: this.bgBrightGreen },
      { name: "bgBrightYellow", method: this.bgBrightYellow },
      { name: "bgBrightBlue", method: this.bgBrightBlue },
      { name: "bgBrightMagenta", method: this.bgBrightMagenta },
      { name: "bgBrightCyan", method: this.bgBrightCyan },
      { name: "bgBrightWhite", method: this.bgBrightWhite }
    ],
    "Text Styles": [
      { name: "bold", method: this.bold },
      { name: "dim", method: this.dim },
      { name: "italic", method: this.italic },
      { name: "underline", method: this.underline },
      { name: "blink", method: this.blink },
      { name: "inverse", method: this.inverse },
      { name: "hidden", method: this.hidden },
      { name: "strikethrough", method: this.strikethrough }
    ]
  };

  console.log("\n" + this.bold(this.cyan("═".repeat(60))));
  console.log(this.bold(this.cyan("COLOR TEXT DEMONSTRATION")));
  console.log(this.bold(this.cyan("═".repeat(60))) + "\n");

  for (const [groupName, colors] of Object.entries(colorGroups)) {
    console.log(this.bold(this.yellow(`\n${groupName}:`)));
    console.log(this.dim("─".repeat(40)));

    colors.forEach(color => {
      const coloredText = color.method.call(this, sampleText);
      if (showCode) {
        // Extract ANSI code for display
        const match = coloredText.match(/\x1b\[([\d;]+)m/);
        const code = match ? match[1] : 'N/A';
        console.log(`  ${color.name.padEnd(20)} ${coloredText} ${this.dim(`(\\x1b[${code}m)`)}`);
      } else {
        console.log(`  ${color.name.padEnd(20)} ${coloredText}`);
      }
    });
  }

  // Show combination examples
  console.log(this.bold(this.yellow("\nCombination Examples:")));
  console.log(this.dim("─".repeat(40)));
  
  const combos = [
    ["red", "bold"],
    ["green", "underline"],
    ["blue", "italic", "bgYellow"],
    ["magenta", "bold", "underline"],
    ["cyan", "inverse"],
    ["orange", "bold", "bgBlue"]
  ];

  combos.forEach((styles, i) => {
    const result = this.combine(sampleText, ...styles.map(s => this[s]));
    console.log(`  ${styles.join(' + ').padEnd(25)} ${result}`);
  });

  // Show RGB examples
  console.log(this.bold(this.yellow("\nRGB Examples:")));
  console.log(this.dim("─".repeat(40)));
  
  const rgbExamples = [
    { name: "Deep Sky Blue", r: 0, g: 191, b: 255 },
    { name: "Coral", r: 255, g: 127, b: 80 },
    { name: "Spring Green", r: 0, g: 255, b: 127 },
    { name: "Goldenrod", r: 218, g: 165, b: 32 }
  ];

  rgbExamples.forEach(example => {
    const colored = this.rgb(sampleText, example.r, example.g, example.b);
    console.log(`  ${example.name.padEnd(20)} ${colored} ${this.dim(`(${example.r},${example.g},${example.b})`)}`);
  });

  console.log("\n" + this.bold(this.cyan("═".repeat(60))));
  console.log(this.dim("Use ColorText.<method>(text) to apply colors"));
  console.log(this.dim("Example: ColorText.red('Error!')"));
  console.log(this.bold(this.cyan("═".repeat(60))) + "\n");
}
}

export default ColorText