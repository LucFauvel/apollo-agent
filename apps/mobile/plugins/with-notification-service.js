// Adds the notification service extension (../notification-service) to the iOS app at
// prebuild: each Apollo notification then shows the bot's avatar as its sender, with
// Apollo's icon small in the corner (iOS "communication notifications").
//
// The app gets the Communication Notifications entitlement and declares the message
// intent the extension donates. Both share an app group, where the app keeps the bots'
// avatar images (src/avatars.ts) for the extension to read. The extension target is
// signed automatically with the app's team (scripts/testflight.sh).
const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, withEntitlementsPlist, withInfoPlist, withXcodeProject } = require("expo/config-plugins");

const TARGET = "NotificationService";
const SOURCE = path.join(__dirname, "..", "notification-service");
const DEPLOYMENT_TARGET = "16.4";
const ENTITLEMENTS = `${TARGET}.entitlements`;

const appGroup = (bundleId) => `group.${bundleId}`;

const entitlementsPlist = (group) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array><string>${group}</string></array>
</dict>
</plist>
`;

module.exports = function withNotificationService(config, { teamId } = {}) {
  config = withEntitlementsPlist(config, (c) => {
    c.modResults["com.apple.developer.usernotifications.communication"] = true;
    const groups = new Set(c.modResults["com.apple.security.application-groups"] ?? []);
    groups.add(appGroup(c.ios.bundleIdentifier));
    c.modResults["com.apple.security.application-groups"] = [...groups];
    return c;
  });

  config = withInfoPlist(config, (c) => {
    const types = new Set(c.modResults.NSUserActivityTypes ?? []);
    types.add("INSendMessageIntent");
    c.modResults.NSUserActivityTypes = [...types];
    return c;
  });

  config = withDangerousMod(config, [
    "ios",
    async (c) => {
      const destination = path.join(c.modRequest.platformProjectRoot, TARGET);
      fs.rmSync(destination, { recursive: true, force: true });
      fs.cpSync(SOURCE, destination, { recursive: true });
      fs.writeFileSync(path.join(destination, ENTITLEMENTS), entitlementsPlist(appGroup(c.ios.bundleIdentifier)));
      return c;
    },
  ]);

  config = withXcodeProject(config, (c) => {
    const project = c.modResults;
    if (project.pbxTargetByName(TARGET)) return c;

    // A group for the extension's files, in the project's main group.
    const group = project.addPbxGroup(["NotificationService.swift", "Info.plist", ENTITLEMENTS], TARGET, TARGET);
    const mainGroup = project.getFirstProject().firstProject.mainGroup;
    project.addToPbxGroup(group.uuid, mainGroup);

    // addTarget expects these sections to exist.
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency ??= {};
    objects.PBXContainerItemProxy ??= {};

    // An app extension target, embedded in the app ("Embed App Extensions").
    const target = project.addTarget(TARGET, "app_extension", TARGET, `${c.ios.bundleIdentifier}.${TARGET}`);
    project.addBuildPhase(["NotificationService.swift"], "PBXSourcesBuildPhase", "Sources", target.uuid);
    project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
    project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);

    const configurations = project.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configurations)) {
      const settings = configurations[key].buildSettings;
      if (!settings || settings.PRODUCT_NAME !== `"${TARGET}"`) continue;
      Object.assign(settings, {
        INFOPLIST_FILE: `${TARGET}/Info.plist`,
        CODE_SIGN_ENTITLEMENTS: `${TARGET}/${ENTITLEMENTS}`,
        PRODUCT_BUNDLE_IDENTIFIER: `"${c.ios.bundleIdentifier}.${TARGET}"`,
        SWIFT_VERSION: "5.0",
        IPHONEOS_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET,
        TARGETED_DEVICE_FAMILY: `"1,2"`,
        MARKETING_VERSION: c.version ?? "1.0.0",
        CURRENT_PROJECT_VERSION: c.ios.buildNumber ?? "1",
        CODE_SIGN_STYLE: "Automatic",
        GENERATE_INFOPLIST_FILE: "NO",
        SKIP_INSTALL: "YES",
        LD_RUNPATH_SEARCH_PATHS: `"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"`,
        ...(teamId ? { DEVELOPMENT_TEAM: teamId } : {}),
      });
    }
    if (teamId) project.addTargetAttribute("DevelopmentTeam", teamId, target);
    return c;
  });

  return config;
};
