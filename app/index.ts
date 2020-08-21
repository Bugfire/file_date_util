import * as fs from "fs";
import * as glob from "glob";
import * as path from "path";
import { exec } from "child_process";
import utimes from "utimes";
import { ExifImage } from "exif";

class Args {
  public readonly isFix: boolean;
  public readonly ignoreDir: boolean;
  public readonly target: string;

  constructor() {
    const { argv } = process;
    if (argv.length !== 4) {
      this.usage();
    }
    const modeIndex = ["check", "check-nodir", "fix", "fix-nodir"].indexOf(
      argv[2]
    );
    if (modeIndex < 0) {
      this.usage();
    }
    this.isFix = modeIndex >= 2;
    this.ignoreDir = modeIndex === 1 || modeIndex === 3;
    this.target = argv[3];
  }

  private usage(): void {
    console.error(`${process.argv[1]} usage:`);
    console.error("  check DIR: check file/directory");
    console.error("  check-nodir DIR: check file/directory");
    console.error("  fix DIR: fix file/directory");
    console.error("  fix-nodir DIR: fix file/directory");
    process.exit(1);
  }
}

class Targets {
  private readonly globPath: string;

  private constructor(filePath: string) {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      if (!filePath.endsWith("/")) {
        filePath += "/";
      }
      this.globPath = filePath + "**/*";
    } else if (stat.isFile()) {
      this.globPath = filePath;
    } else {
      console.error(`Unknown target [${filePath}]`);
      process.exit(1);
    }
  }

  public static get(filePath: string): string[] {
    return glob.sync(new Targets(filePath).globPath);
  }
}

interface FileStat {
  begin: Date | undefined;
  end: Date | undefined;
  meta_time: Date | undefined;
  ctime: Date;
  mtime: Date;
  btime: Date;
  invalid: boolean;
  fixable: boolean;
}

class FileStatsUtil {
  private constructor() {}

  private static readonly monthMatcher = RegExp(/\/(\d{4})\/(\d{4})-(\d{2})/);
  private static readonly yearMatcher = RegExp(/\/(\d{4})\/(\d{4})-[^\d]/);

  private static rangeFromPath(filePath: string): [Date, Date] | null {
    {
      const mm = this.monthMatcher.exec(filePath);
      if (mm !== null) {
        if (mm[1] !== mm[2]) {
          console.error(`Year mismatch ${mm[1]} !== ${mm[2]} on ${filePath}`);
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
      const ym = this.yearMatcher.exec(filePath);
      if (ym !== null) {
        if (ym[1] !== ym[2]) {
          console.error(`Year mismatch ${ym[1]} !== ${ym[2]} on ${filePath}`);
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

  private static async getDateFromExif(
    filePath: string
  ): Promise<Date | undefined> {
    return new Promise((resolve) => {
      try {
        new ExifImage({ image: filePath }, (error, exifData) => {
          if (error) {
            if (error.message !== "No Exif segment found in the given image.") {
              console.error(`Error: ${filePath} - ${error.message}}`);
            }
            return resolve(undefined);
          } else {
            const meta_time_str = exifData.exif.CreateDate;
            if (meta_time_str) {
              // YYYY:MM:DD hh:mm:ss
              if (meta_time_str[4] === ":" && meta_time_str[7] === ":") {
                const s = meta_time_str.split(":");
                const f = `${s[0]}/${s[1]}/${s[2]}:${s[3]}:${s[4]}`;
                return resolve(new Date(f));
              }
            } else {
              return resolve(undefined);
            }
          }
        });
      } catch (e) {
        console.error(e);
        resolve(undefined);
      }
    });
  }

  private static async check(
    filePath: string,
    ignoreDir: boolean
  ): Promise<FileStat> {
    const stats = fs.statSync(filePath);
    const { ctime, mtime, birthtime } = stats;

    const range = this.rangeFromPath(filePath);
    const meta_time = await this.getDateFromExif(filePath);

    const r: FileStat = {
      begin: range ? range[0] : undefined,
      end: range ? range[1] : undefined,
      meta_time,
      ctime,
      mtime,
      btime: birthtime,
      invalid: false,
      fixable:
        ignoreDir ||
        (range != null &&
          meta_time !== undefined &&
          meta_time >= range[0] &&
          meta_time < range[1]),
    };
    if (!meta_time) {
      r.invalid = true;
      return r;
    }
    const DELTA_MAX = 10 * 1000; // 10 seconds
    const check0 =
      !ignoreDir && (!range || meta_time < range[0] || meta_time >= range[1]);
    const check3 = Math.abs(meta_time.getTime() - ctime.getTime()) > DELTA_MAX;
    const check1 = Math.abs(meta_time.getTime() - mtime.getTime()) > DELTA_MAX;
    const check2 =
      Math.abs(meta_time.getTime() - birthtime.getTime()) > DELTA_MAX;
    r.invalid = check0 || check1 || check2 || check3;
    return r;
  }

  private static dateFormat(date: Date | undefined): string {
    if (!date) {
      return "UNKNOWN";
    } else {
      return date.toLocaleString();
    }
  }

  private static log(filePath: string, fileStat: FileStat) {
    console.log(`${filePath}:`);
    console.log(`  ctime:    ${fileStat.ctime.toLocaleString()}`);
    console.log(`  mtime:    ${fileStat.mtime.toLocaleString()}`);
    console.log(`  btime:    ${fileStat.btime.toLocaleString()}`);
    console.log(`  meta_time:${this.dateFormat(fileStat.meta_time)}`);
    console.log(`  begin:    ${this.dateFormat(fileStat.begin)}`);
    console.log(`  end:      ${this.dateFormat(fileStat.end)}`);
  }

  public static async dump(
    filePath: string,
    ignoreDir: boolean
  ): Promise<boolean> {
    const fileInfo = await this.check(filePath, ignoreDir);
    if (!fileInfo.invalid) {
      return false;
    }
    this.log(filePath, fileInfo);
    return fileInfo.invalid;
  }

  public static async fix(
    filePath: string,
    ignoreDir: boolean
  ): Promise<boolean> {
    const fileInfo = await this.check(filePath, ignoreDir);
    if (!fileInfo.invalid) {
      return false;
    }
    this.log(filePath, fileInfo);
    if (fileInfo.fixable && fileInfo.meta_time) {
      console.log(`  modified to => ${fileInfo.meta_time.toLocaleString()}`);
      fs.utimesSync(filePath, fileInfo.meta_time, fileInfo.meta_time);
      await utimes(filePath, {
        atime: fileInfo.meta_time.getTime(),
        mtime: fileInfo.meta_time.getTime(),
        btime: fileInfo.meta_time.getTime(),
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
  console.log(`${targets.length} files...`);

  let totalFiles = 0;
  let filteredFiles = 0;

  for (const filePath of targets) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      continue;
    }
    if (path.basename(filePath) === "Picasa.ini") {
      continue;
    }
    totalFiles++;
    if (args.isFix) {
      const filtered = await FileStatsUtil.fix(filePath, args.ignoreDir);
      if (filtered) {
        filteredFiles++;
      }
    } else {
      const filtered = await FileStatsUtil.dump(filePath, args.ignoreDir);
      if (filtered) {
        filteredFiles++;
      }
    }
  }
  if (filteredFiles === 0) {
    console.log("no target files");
  } else {
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
}

exec(
  "ffmpeg -i /Volumes/Data2/Work4/movies/IMG_1554.MP4 -dump",
  (err, stdout, stderr) => {
    console.log(err);
    console.log(stderr);
    console.log(stdout);
  }
);

//void main();
