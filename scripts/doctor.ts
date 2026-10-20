import { run } from "../server/media";
for (const binary of ["node", "ffmpeg", "yt-dlp", "xcodegen"]) {
  try {
    console.log(
      `${binary}: ${(await run(binary, [binary === "ffmpeg" ? "-version" : "--version"], 5000)).split("\n")[0]}`,
    );
  } catch {
    console.log(`${binary}: missing`);
    process.exitCode = 1;
  }
}
console.log(
  "Next: npm run build; npm start. For phone/car access, use a trusted HTTPS tunnel or your own HTTPS reverse proxy.",
);
