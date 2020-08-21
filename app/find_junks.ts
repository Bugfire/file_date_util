import * as glob from "glob";

class Args {
  public readonly target: string;

  constructor() {
    const { argv } = process;
    if (argv.length !== 3) {
      this.usage();
    }
    this.target = argv[2];
  }

  private usage(): void {
    console.error(`${process.argv[1]} usage:`);
    console.error("  DIR");
    process.exit(1);
  }
}

const args = new Args();

const files = glob.sync(args.target + "/**/*");

const map = new Map<string, string[]>();
files.forEach((v) => {
  let lv = v.toLowerCase();
  if (lv.endsWith(".jpeg")) {
    lv = lv.substr(0, lv.length - 4) + "jpg";
  }
  const mlv = map.get(lv);
  if (mlv) {
    map.set(lv, mlv.concat(v));
  } else {
    map.set(lv, [v]);
  }
});

map.forEach((m) => {
  if (m.length > 1) {
    console.error(`Found junk entries [${m.join(",")}]`);
  }
});
