class Args {
  public readonly isFix: boolean;
  public readonly target: string;

  constructor() {
    const { argv } = process;
    if (argv.length !== 4) {
      this.usage();
    }
    const modeIndex = ["fix", "check"].indexOf(argv[2]);
    if (modeIndex < 0) {
      this.usage();
    }
    this.isFix = modeIndex === 0;
    this.target = argv[3];
  }

  private usage(): void {
    console.error(`${process.argv[1]} usage:`);
    console.error("  check DIR: check directory");
    console.error("  fix DIR: fix directory");
    process.exit(1);
  }
}

const args = new Args();
console.log(`Mode=[${args.isFix ? "Fix" : "Check"}] Target=[${args.target}]`);
