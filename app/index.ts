import * as fs from "fs";
import * as glob from "glob";
// import utimes from "utimes";
import { ExifImage } from "exif";

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
    console.error("  check DIR: check file/directory");
    console.error("  fix DIR: fix file/directory");
    process.exit(1);
  }
}

class Targets {
  private readonly globPath: string;

  private constructor(path: string) {
    const stat = fs.statSync(path);
    if (stat.isDirectory()) {
      if (!path.endsWith("/")) {
        path += "/";
      }
      this.globPath = path + "**/*";
    } else if (stat.isFile()) {
      this.globPath = path;
    } else {
      console.error(`Unknown target [${path}]`);
      process.exit(1);
    }
  }

  public static get(path: string): string[] {
    return glob.sync(new Targets(path).globPath);
  }
}

class FileStatsUtil {
  private constructor() {}

  private static check(
    path: string,
    callback: (
      ex_ctime: Date | undefined,
      ctime: Date,
      mtime: Date,
      birthtime: Date,
      modified: boolean
    ) => void
  ) {
    const stats = fs.statSync(path);
    const { ctime, mtime, birthtime } = stats;

    try {
      new ExifImage({ image: path }, (error, exifData) => {
        let ex_ctime: Date | undefined;
        let noExif = false;
        if (error) {
          if (error.message === "No Exif segment found in the given image.") {
            noExif = true;
          } else {
            console.error(`Error: ${path} - ${error.message}}`);
          }
        } else {
          const ex_ctime_str = exifData.exif.CreateDate;
          if (ex_ctime_str) {
            // YYYY:MM:DD hh:mm:ss
            if (ex_ctime_str[4] === ":" && ex_ctime_str[7] === ":") {
              const s = ex_ctime_str.split(":");
              const f = `${s[0]}/${s[1]}/${s[2]}:${s[3]}:${s[4]}`;
              ex_ctime = new Date(f);
            }
          } else {
            noExif = true;
          }
        }
        const check1 = Math.abs(ctime.getTime() - mtime.getTime()) > 2000;
        const check2 = Math.abs(ctime.getTime() - birthtime.getTime()) > 2000;
        if (ex_ctime) {
          const check3 = Math.abs(ctime.getTime() - ex_ctime.getTime()) > 2000;
          callback(
            ex_ctime,
            ctime,
            mtime,
            birthtime,
            check1 || check2 || check3
          );
        } else {
          callback(
            undefined,
            ctime,
            mtime,
            birthtime,
            !noExif || check1 || check2
          );
        }
      });
    } catch (error) {
      console.error(`Exception: ${path} - ${(error as Error).message}}`);
    }
  }

  private static log(
    path: string,
    ex_ctime: Date | undefined,
    ctime: Date,
    mtime: Date,
    btime: Date
  ) {
    console.log(`${path}:`);
    console.log(
      `  ex_ctime: ${ex_ctime ? ex_ctime.toLocaleString() : "ERROR"}`
    );
    console.log(`  ctime: ${ctime.toLocaleString()}`);
    console.log(`  mtime: ${mtime.toLocaleString()}`);
    console.log(`  btime: ${btime.toLocaleString()}`);
  }

  public static dump(path: string) {
    this.check(path, (ex_ctime, ctime, mtime, btime, modified) => {
      if (!modified) {
        return;
      }
      this.log(path, ex_ctime, ctime, mtime, btime);
    });
  }

  public static fix(path: string): void {
    this.check(path, (ex_ctime, ctime, mtime, btime, modified) => {
      if (!modified) {
        return;
      }
      this.log(path, ex_ctime, ctime, mtime, btime);
      if (ex_ctime) {
        console.log(`  ctime and mtime => ${ex_ctime.toLocaleString()}`);
        fs.utimesSync(path, ex_ctime, ex_ctime);
        /*
        const p = utimes(path, {
          btime: ex_ctime.getTime(),
        });
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        p.then(() => {
          // do nothing
        });
        */
      }
    });
  }
}

const args = new Args();
console.log(`Mode=[${args.isFix ? "Fix" : "Check"}] Target=[${args.target}]`);

const targets = Targets.get(args.target);
targets.forEach((path) => {
  const stat = fs.statSync(path);
  if (!stat.isFile()) {
    return;
  }
  if (args.isFix) {
    FileStatsUtil.fix(path);
  } else {
    FileStatsUtil.dump(path);
  }
});
