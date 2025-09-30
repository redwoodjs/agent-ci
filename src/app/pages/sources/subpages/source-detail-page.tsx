import { db } from "@/db";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";

export async function SourceDetailPage({
  params,
}: {
  params: { sourceID: string };
}) {
  const artifacts = await db
    .selectFrom("artifacts")
    .where("artifacts.sourceID", "=", parseInt(params.sourceID))
    .innerJoin("subjects", "subjects.artifactID", "artifacts.id")
    .selectAll("artifacts")
    .select(["subjects.name as subjectName"])
    .execute();

  return (
    <div className="flex-1 p-6 bg-white w-full">
      <div className="max-w-7xl mx-auto w-full">
        <div className="border rounded-lg bg-white">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Subject</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {artifacts.map((artifact, index) => (
                <TableRow key={index} className="group">
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">
                        {artifact.subjectName}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(artifact.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="mt-4 text-sm text-muted-foreground">
          Showing {artifacts.length}{" "}
          {artifacts.length === 1 ? "subject" : "subjects"}
        </div>
      </div>
    </div>
  );
}
