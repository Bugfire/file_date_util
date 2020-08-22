import * as fs from "fs";
import * as glob from "glob";
import * as path from "path";
import { exec } from "child_process";
import utimes from "utimes";
import { ExifImage } from "exif";

type FileFlag = "normal" | "no_meta" | "fixable";

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
  flag: FileFlag;
  validDir: boolean;
}

class FileStatsUtil {
  private constructor() {}

  private static readonly monthMatcher = RegExp(
    /\/(\d{4})\/(Movies-)?(\d{4})-(\d{2})/
  );
  private static readonly yearMatcher = RegExp(/\/(\d{4})\/(\d{4})-[^\d]/);
  // creation_time   : 2019-03-09T11:08:48.000000Z
  private static readonly ffmpegMatcher = RegExp(
    /\s+creation_time\s+:\s+([-0-9:TZ.]+)/
  );

  private static rangeFromPath(filePath: string): [Date, Date] | null {
    {
      const mm = this.monthMatcher.exec(filePath);
      if (mm !== null) {
        if (mm[1] !== mm[3]) {
          console.error(`Year mismatch ${mm[1]} !== ${mm[2]} on ${filePath}`);
        } else {
          const year = parseInt(mm[1], 10);
          const month = parseInt(mm[4], 10);
          if (year <= 1950 || year > 2030 || month < 1 || month > 12) {
            console.error(`Invalid year or month (${year}/${month})`);
          } else {
            const begin = new Date(`${mm[1]}-${mm[4]}-01T00:00:00+0900`);
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
            let meta_time_str = exifData.exif.CreateDate;
            if (!meta_time_str || meta_time_str.indexOf(":") < 0) {
              meta_time_str = exifData.exif.DateTimeOriginal;
            }
            if (meta_time_str) {
              // YYYY:MM:DD hh:mm:ss
              if (meta_time_str[4] === ":" && meta_time_str[7] === ":") {
                const s = meta_time_str.split(":");
                const f = `${s[0]}/${s[1]}/${s[2]}:${s[3]}:${s[4]}`;
                return resolve(new Date(f));
              } else {
                console.error(
                  `Error: ${filePath} - Invalid date format ${meta_time_str}`
                );
                return resolve(undefined);
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

  private static async getDateByFfmpeg(
    filePath: string
  ): Promise<Date | undefined> {
    return new Promise((resolve) => {
      exec(`ffmpeg -i "${filePath}" -dump`, (_err, _stdout, stderr) => {
        const m = this.ffmpegMatcher.exec(stderr);
        if (!m) {
          return resolve(undefined);
        }
        return resolve(new Date(m[1]));
      });
    });
  }

  private static async check(
    filePath: string,
    ignoreDir: boolean
  ): Promise<FileStat> {
    const stats = fs.statSync(filePath);
    const { ctime, mtime, birthtime } = stats;

    const range = this.rangeFromPath(filePath);
    const extname = path.extname(filePath);
    let meta_time: Date | undefined;
    switch (extname.toLowerCase()) {
      case ".jpg":
      case ".jpeg":
        meta_time = await this.getDateFromExif(filePath);
        break;
      case ".mp4":
      case ".mov":
      case ".mts":
      case ".m2ts":
      case ".avi":
        meta_time = await this.getDateByFfmpeg(filePath);
        break;
      default:
        console.log(`Unknown ext [${filePath}]`);
        break;
    }
    if (
      meta_time &&
      (meta_time.getTime() === 0 || isNaN(meta_time.getTime()))
    ) {
      meta_time = undefined;
    }

    const r: FileStat = {
      begin: range ? range[0] : undefined,
      end: range ? range[1] : undefined,
      meta_time,
      ctime,
      mtime,
      btime: birthtime,
      flag: "normal",
      validDir:
        ignoreDir ||
        (range != null &&
          meta_time !== undefined &&
          meta_time >= range[0] &&
          meta_time < range[1]),
    };
    if (!meta_time) {
      r.flag = "no_meta";
      return r;
    }
    const DELTA_MAX = 10 * 1000; // 10 seconds
    const check0 =
      !ignoreDir && (!range || meta_time < range[0] || meta_time >= range[1]);
    const check3 = Math.abs(meta_time.getTime() - ctime.getTime()) > DELTA_MAX;
    const check1 = Math.abs(meta_time.getTime() - mtime.getTime()) > DELTA_MAX;
    const check2 =
      Math.abs(meta_time.getTime() - birthtime.getTime()) > DELTA_MAX;
    if (check0 || check1 || check2 || check3) {
      r.flag = "fixable";
    } else {
      r.flag = "normal";
    }
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
  ): Promise<FileFlag> {
    const fileInfo = await this.check(filePath, ignoreDir);
    if (!fileInfo.meta_time) {
      console.log(`${filePath}: NO Meta data!`);
    }
    if (fileInfo.flag !== "fixable") {
      return fileInfo.flag;
    }
    this.log(filePath, fileInfo);
    return fileInfo.flag;
  }

  public static async fix(
    filePath: string,
    ignoreDir: boolean
  ): Promise<boolean> {
    const fileInfo = await this.check(filePath, ignoreDir);
    if (
      fileInfo.flag !== "fixable" ||
      !fileInfo.validDir ||
      !fileInfo.meta_time
    ) {
      return false;
    }
    this.log(filePath, fileInfo);
    console.log(`  modified to => ${fileInfo.meta_time.toLocaleString()}`);
    fs.utimesSync(filePath, fileInfo.meta_time, fileInfo.meta_time);
    await utimes(filePath, {
      atime: fileInfo.meta_time.getTime(),
      mtime: fileInfo.meta_time.getTime(),
      btime: fileInfo.meta_time.getTime(),
    });
    return true;
  }
}

async function main(): Promise<void> {
  const args = new Args();
  console.log(`Mode=[${args.isFix ? "Fix" : "Check"}] Target=[${args.target}]`);

  const targets = Targets.get(args.target);
  console.log(`Checking ${targets.length} files...`);

  let totalFiles = 0;

  if (args.isFix) {
    let fixedFiles = 0;
    for (const filePath of targets) {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        continue;
      }
      if (path.basename(filePath) === "Picasa.ini") {
        continue;
      }
      totalFiles++;
      const fixed = await FileStatsUtil.fix(filePath, args.ignoreDir);
      if (fixed) {
        fixedFiles++;
      }
    }
    if (fixedFiles === 0) {
      console.log("no fixable files");
    } else {
      console.log(
        `Modified ${fixedFiles} files in total ${totalFiles} files .`
      );
    }
  } else {
    let fixableFiles = 0;
    let noMetaFiles = 0;
    for (const filePath of targets) {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        continue;
      }
      if (path.basename(filePath) === "Picasa.ini") {
        continue;
      }
      totalFiles++;
      const flag = await FileStatsUtil.dump(filePath, args.ignoreDir);
      switch (flag) {
        case "fixable":
          fixableFiles++;
          break;
        case "no_meta":
          noMetaFiles++;
          break;
        case "normal":
          break;
      }
    }
    if (fixableFiles === 0 && noMetaFiles === 0) {
      console.log("no fixable files");
    } else {
      console.log(
        `No-meta ${noMetaFiles} files and Fixable ${fixableFiles} in total ${totalFiles} files .`
      );
    }
  }
}

void main();
