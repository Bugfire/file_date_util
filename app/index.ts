import * as fs from "fs";
import * as glob from "glob";
import utimes from "utimes";
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

interface FileStat {
  begin: Date | undefined;
  end: Date | undefined;
  ex_ctime: Date | undefined;
  ctime: Date;
  mtime: Date;
  btime: Date;
  invalid: boolean;
}

class FileStatsUtil {
  private constructor() {}

  private static readonly monthMatcher = RegExp(/\/(\d{4})\/(\d{4})-(\d{2})/);
  private static readonly yearMatcher = RegExp(/\/(\d{4})\/(\d{4})-[^\d]/);

  private static rangeFromPath(path: string): [Date, Date] | null {
    {
      const mm = this.monthMatcher.exec(path);
      if (mm !== null) {
        if (mm[1] !== mm[2]) {
          console.error(`Year mismatch ${mm[1]} !== ${mm[2]} on ${path}`);
        } else {
          const year = parseInt(mm[1], 10);
          const month = parseInt(mm[3], 10);
          if (year <= 1950 || year > 2030 || month < 1 || month > 12) {
            console.error(`Invalid year or month (${year}/${month})`);
          } else {
            const begin = new Date(`${mm[1]}-${mm[3]}-01T00:00:00+0900`);
            if (month === 12) {
              const endYear = `000${year + 1}`.substr(-4);
              const end = new Date(`${endYear}-01-01T00:00:00+0900`);
              return [begin, end];
            } else {
              const endMonth = `0${month + 1}`.substr(-2);
              const end = new Date(`${mm[1]}-${endMonth}-01T00:00:00+0900`);
              return [begin, end];
            }
          }
        }
        return null;
      }
    }
    {
      const ym = this.yearMatcher.exec(path);
      if (ym !== null) {
        if (ym[1] !== ym[2]) {
          console.error(`Year mismatch ${ym[1]} !== ${ym[2]} on ${path}`);
        }
        const begin = new Date(`${ym[1]}-01-01T00:00:00+0900`);
        const year = parseInt(ym[1], 10);
        const endYear = `000${year + 1}`.substr(-4);
        const end = new Date(`${endYear}-01-01T00:00:00+0900`);
        return [begin, end];
      }
    }
    return null;
  }

  private static check(path: string): Promise<FileStat> {
    return new Promise((resolve, reject) => {
      const stats = fs.statSync(path);
      const { ctime, mtime, birthtime } = stats;

      try {
        const range = this.rangeFromPath(path);
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
          const DELTA_MAX = 10 * 1000; // 10 seconds
          const check0 = !range || ctime < range[0] || ctime >= range[1];
          const check1 =
            Math.abs(ctime.getTime() - mtime.getTime()) > DELTA_MAX;
          const check2 =
            Math.abs(ctime.getTime() - birthtime.getTime()) > DELTA_MAX;

          const r: FileStat = {
            begin: range ? range[0] : undefined,
            end: range ? range[1] : undefined,
            ex_ctime,
            ctime,
            mtime,
            btime: birthtime,
            invalid: false,
          };
          if (ex_ctime) {
            const check3 =
              Math.abs(ctime.getTime() - ex_ctime.getTime()) > DELTA_MAX;
            r.invalid = check0 || check1 || check2 || check3;
            return resolve(r);
          } else {
            r.invalid = check0 || check1 || check2 || noExif;
            return resolve(r);
          }
        });
      } catch (error) {
        console.error(`Exception: ${path} - ${(error as Error).message}}`);
        return reject();
      }
    });
  }

  private static dateFormat(date: Date | undefined): string {
    if (!date) {
      return "UNKNOWN";
    } else {
      return date.toLocaleString();
    }
  }

  private static log(path: string, fileStat: FileStat) {
    console.log(`${path}:`);
    console.log(`  ctime:    ${fileStat.ctime.toLocaleString()}`);
    console.log(`  mtime:    ${fileStat.mtime.toLocaleString()}`);
    console.log(`  btime:    ${fileStat.btime.toLocaleString()}`);
    console.log(`  ex_ctime: ${this.dateFormat(fileStat.ex_ctime)}`);
    console.log(`  begin:    ${this.dateFormat(fileStat.begin)}`);
    console.log(`  end:      ${this.dateFormat(fileStat.end)}`);
  }

  public static async dump(path: string): Promise<boolean> {
    const fileInfo = await this.check(path);
    if (!fileInfo.invalid) {
      return false;
    }
    this.log(path, fileInfo);
    return fileInfo.invalid;
  }

  public static async fix(path: string): Promise<boolean> {
    const fileInfo = await this.check(path);
    if (!fileInfo.invalid) {
      return false;
    }
    this.log(path, fileInfo);
    if (fileInfo.ex_ctime) {
      console.log(`  modified to => ${fileInfo.ex_ctime.toLocaleString()}`);
      //fs.utimesSync(path, fileInfo.ex_ctime, fileInfo.ex_ctime);
      const p = utimes(path, {
        atime: fileInfo.ex_ctime.getTime(),
        mtime: fileInfo.ex_ctime.getTime(),
        btime: fileInfo.ex_ctime.getTime(),
      });
      void p.then(() => {
        // do nothing
      });
      return true;
    }
    return false;
  }
}

async function main(): Promise<void> {
  const args = new Args();
  console.log(`Mode=[${args.isFix ? "Fix" : "Check"}] Target=[${args.target}]`);

  const targets = Targets.get(args.target);
  console.log(`${targets.length} targets...`);

  let totalFiles = 0;
  let filteredFiles = 0;

  for (const path of targets) {
    const stat = fs.statSync(path);
    if (!stat.isFile()) {
      continue;
    }
    totalFiles++;
    if (args.isFix) {
      const filtered = await FileStatsUtil.fix(path);
      if (filtered) {
        filteredFiles++;
      }
    } else {
      const filtered = await FileStatsUtil.dump(path);
      if (filtered) {
        filteredFiles++;
      }
    }
  }
  if (args.isFix) {
    console.log(
      `Modified ${filteredFiles} files in total ${totalFiles} files .`
    );
  } else {
    console.log(
      `Invalid ${filteredFiles} files in total ${totalFiles} files .`
    );
  }
}

void main();
