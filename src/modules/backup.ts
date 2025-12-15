import { FilePickerHelper } from "zotero-plugin-toolkit";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import {
  copyDirectory,
  findBackupItem,
  removeDirectory,
  unzipToTemporaryDir,
  zipDirectory,
} from "../utils/tools";

// @ts-ignore
const { AddonManager } = ChromeUtils.import(
  "resource://gre/modules/AddonManager.jsm",
);

interface AddonInfo {
  id: string;
  spec: string;
}

export async function createBackupItem(): Promise<number | boolean> {
  if (Zotero.Users.getCurrentUserID() !== getPref("adminID"))
    return false;
  const oldItemID = await findBackupItem();
  if (oldItemID && Zotero.Items.get(oldItemID as number))
    await Zotero.Items.erase(oldItemID as number);
  const item = new Zotero.Item("document");
  item.setField("title", "Tara_Backup");
  const groupID = getPref("groupID");
  item.libraryID = Zotero.Groups.getLibraryIDFromGroupID(groupID);
  return await item.saveTx() as number;
}

function isValidPref(this: any, pref: string): boolean {
  ztoolkit.log(`checking pref ${pref}`);
  const matchingPolicies = this.filter((policy: any) =>
    pref.startsWith(policy.branch + ".")
  );

  if (matchingPolicies.length === 0)
    return false;

  // Follow the most specific policy
  const matchedPolicy = matchingPolicies.sort((a: any, b: any) =>
    b.branch.length - a.branch.length
  )[0];

  const remainingKey = pref.slice(matchedPolicy.branch.length + 1);
  const keyInList = matchedPolicy.keys.includes(remainingKey);

  if (matchedPolicy.keysMode === "white")
    return keyInList;
  else if (matchedPolicy.keysMode === "black")
    return !keyInList;

  return false; // no defined behavior yet
}

// Only user modified prefs will be kept
async function getPrefs(policies: any, outDir: string) {
  const rootBranch = ztoolkit.getGlobal("Zotero").Prefs
    .rootBranch as rootBranch;
  let prefsKey: string[] = rootBranch
    .getChildList("extensions.")
    .filter((p: string) => rootBranch.prefHasUserValue(p))
    .filter(isValidPref, policies.branches);
  const prefs = prefsKey.reduce((a: any, c: string) => {
    a[c] = Zotero.Prefs.get(c, true);
    return a;
  }, {});

  const pf = PathUtils.join(outDir, "preferences.json");
  await IOUtils.writeJSON(pf, prefs);
}

async function getAddons(policies: any, outDir: string) {
  const addoninfos: Array<AddonInfo> = [];
  for (const addon of await AddonManager.getAllAddons()) {
    const id = addon.id;
    if (!id || policies.keys.includes(id) && policies.keysMode === "black" || !(policies.keys.includes(id)) && policies.keysMode === "white") continue;
    const update = await fetch(addon.updateURL).then((res) => res.json());
    addoninfos.push({
      id: id,
      // @ts-ignore
      spec: update.addons[id].updates[0].update_link,
    });
  }

  const pf = PathUtils.join(outDir, "addons.json");
  await IOUtils.writeJSON(pf, addoninfos);
}

async function getStyles(policies: any, outDir: string, dataDir: string) {
  const styles = Zotero.Styles.getAll();
  for (const styleID in styles) {
    if (
      (policies.keysMode === "white" &&
        !policies.keys.includes(styleID)) ||
      (policies.keysMode === "black" &&
        policies.keys.includes(styleID))
    ) {
      continue;
    }
    const stylePath = PathUtils.join(dataDir, "styles", styles[styleID].fileName);
    const targetPath = PathUtils.join(outDir, styles[styleID].fileName);
    await IOUtils.copy(stylePath, targetPath);
  }
}

async function getTranslators(policies: any, outDir: string, dataDir: string) {
  const translators = await Zotero.Translators.getAll();
  for (const translator of translators) {
    if (
      (policies.keysMode === "white" &&
        !policies.keys.includes(translator.translatorID)) ||
      (policies.keysMode === "black" &&
        policies.keys.includes(translator.translatorID))
    ) {
      continue;
    }
    const translatorPath = PathUtils.join(dataDir, "translators", translator.fileName);
    const targetPath = PathUtils.join(outDir, translator.fileName);
    await IOUtils.copy(translatorPath, targetPath);
  }
}

async function getLocate(policies: any, outDir: string, dataDir: string) {
  // const s = PathUtils.join(dataDir, "locate");
  // const t = PathUtils.join(outDir, "locate");
  // if (await IOUtils.exists(s))
  //   await IOUtils.copy(s, t, { recursive: true });
}

export async function createBackupAsAttachment() {
  const tmpDir = Zotero.getTempDirectory();
  const outDir = tmpDir.path as string;
  const dataDir: string = Zotero.Prefs.get("dataDir") as string;

  tmpDir.append("Backup");
  if (tmpDir.exists()) removeDirectory(outDir);
  await IOUtils.makeDirectory(outDir);
  const result = await createBackupItem();
  if (result === false) return;
  const item = Zotero.Items.get(result as number);

  const policies = require("./PrefPolicies.json");
  await getPrefs(policies.preferences, outDir);
  await getAddons(policies.addons, outDir);
  await getStyles(policies.styles, outDir, dataDir);
  await getTranslators(policies.translators, outDir, dataDir);
  // await getLocate(policies.locate, outDir, dataDir);
  await Zotero.File.iterateDirectory(outDir, async (entry: any) => {
    if (!entry.isDirectory) {
      const importOptions = {
        file: PathUtils.join(outDir, entry.name),
        title: entry.name,
        parentItemID: item.id,
      };
      await Zotero.Attachments.importFromFile(importOptions);
    }
  });
}

export async function restoreFromBackup() {
  const backupItemID = await findBackupItem();
  const attachmentID = Zotero.Items.get(backupItemID as number).getAttachments()[0];
  const attachment = Zotero.Items.get(attachmentID as number);
  const filename = attachment.getFilePath() as string;
  const cacheTmp = Zotero.getTempDirectory();
  cacheTmp.append("Backup");
  if (cacheTmp.exists()) {
    removeDirectory(cacheTmp.path);
  }
  const tmpDir = cacheTmp.path;
  const dataDir = Zotero.Prefs.get("dataDir") as string;
  await addon.data.progress.openProgressWindow({
    header: getString("restore-header"),
  });
  const backupPrefsPath = PathUtils.join(tmpDir, "backup.json");
  let backupPrefs: any;
  let success = true;
  const retest = new RegExp("dir|path|folder", "i");
  let s: any, t: any;
  try {
    ztoolkit.log("restore unzip");
    await unzipToTemporaryDir(filename, tmpDir);
    ztoolkit.log("restore addons");
    backupPrefs = await IOUtils.readJSON(backupPrefsPath);
    for (const addon of backupPrefs.addons) {
      ztoolkit.log(`install addon ${addon.id}`);
      const install = await AddonManager.getInstallForURL(addon.spec);
      await install.install();
    }
    for (const task of ["styles", "translators"]) {
      ztoolkit.log(`restore ${task}`);
      s = PathUtils.join(tmpDir, task);
      t = PathUtils.join(dataDir, task);
      if (await IOUtils.exists(s)) {
        ztoolkit.log(s + " " + t);
        await copyDirectory(s, t);
      }
    }
    ztoolkit.log("restore locate");
    s = PathUtils.join(tmpDir, "locate");
    t = PathUtils.join(dataDir, "locate");
    if (await IOUtils.exists(s)) {
      await Zotero.File.iterateDirectory(s, async function (entry: any) {
        if (entry.name === "engines.json") {
          const enginesBackup = await IOUtils.readJSON(
            PathUtils.join(s, entry.name),
          );
          const engines = await IOUtils.readJSON(
            PathUtils.join(t, entry.name),
          );
          const engineNames = engines.map((e: any) => e._name);
          enginesBackup.forEach((e: any) => {
            if (!engineNames.includes(e._name)) {
              engines.push(e);
            }
          });
          await IOUtils.writeJSON(PathUtils.join(t, entry.name), engines);
        } else {
          await IOUtils.copy(
            PathUtils.join(s, entry.name),
            PathUtils.join(t, entry.name),
          );
        }
      });
    } else {
      ztoolkit.log("missing source locate folder");
    }
    ztoolkit.log("restore preferences");
    backupPrefs = await IOUtils.readJSON(backupPrefsPath);
    const policy = require("./PrefPolicies.json");
    for (const pkey in backupPrefs.preferences) {
      if (isValidPref.call(policy, pkey)) continue;

      if (
        retest.test(pkey) &&
        typeof backupPrefs.preferences[pkey] == "string"
      ) {
        ztoolkit.log(pkey);
        ztoolkit.log(backupPrefs.preferences[pkey]);
        let isExists = false;
        try {
          isExists = await IOUtils.exists(backupPrefs.preferences[pkey]);
        } catch (e) {
          ztoolkit.log(
            `Is not a path ${pkey}:${backupPrefs.preferences[pkey]}`,
          );
        }
        if (!isExists) continue;
      }
      if (backupPrefs.preferences[pkey]) {
        Zotero.Prefs.set(
          pkey,
          backupPrefs.preferences[pkey],
          true, // All preferences are set in global.
        );
      }
    }
  } catch (e) {
    ztoolkit.log(e);
    success = false;
    addon.data.progress.queue = [];
  }
  let caution = "";
  addon.data.progress.completeProgressWindow(
    success,
    success ? getString("restore-success") : getString("restore-fail"),
    success
      ? getString("restore-success-msg") + "<br />" + caution
      : getString("restore-fail-msg"),
  );
}
