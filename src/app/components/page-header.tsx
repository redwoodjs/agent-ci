import { ArrowLeft, LogOut, User } from "lucide-react";

export function PageHeader({
  title,
  backUrl,
  user,
}: {
  title: string;
  backUrl: string;
  user?: { email: string };
}) {
  return (
    <div className="border-b bg-white border-gray-200 px-6 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <a href={backUrl} className="w-4 h-4">
            <ArrowLeft className="w-4 h-4" />
          </a>

          <div className="flex items-center gap-3">
            <h1 className="text-xl">{title}</h1>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {user && (
            <>
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <User className="w-4 h-4" />
                <span>{user.email}</span>
              </div>
              <a
                href="/auth/functions/sign-out"
                className="inline-flex items-center justify-center rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3"
              >
                <LogOut className="w-4 h-4 mr-2" />
                Log Out
              </a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
