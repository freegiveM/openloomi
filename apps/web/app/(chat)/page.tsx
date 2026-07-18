import { after } from "next/server";
import { Home } from "./home";
import { initializeSkillsBundler } from "@/lib/ai/skills/init";

export default async function Page() {
  // Skills bundler init is only meaningful in Tauri. Defer it to after the
  // response stream finishes so it can't block the home route's first paint
  // or TTFB. Errors are logged inside `initializeSkillsBundler`.
  after(() => {
    void initializeSkillsBundler();
  });

  return (
    <>
      <Home key="stable-chat-panel" />
    </>
  );
}
