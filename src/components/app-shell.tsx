import { Outlet } from "react-router-dom";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

export function AppShell() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground antialiased">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
