import { Subject } from "../types";

export class SubjectGraphDO implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Cloudflare.Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    return new Response("Not implemented - use RPC methods", { status: 501 });
  }

  async getSubject(id: string): Promise<Subject | undefined> {
    return this.state.storage.get<Subject>(id);
  }

  async putSubject(subject: Subject): Promise<void> {
    return this.state.storage.put(subject.id, subject);
  }

  async updateSubjectDocumentIds(
    subjectId: string,
    documentId: string
  ): Promise<void> {
    const subject = await this.getSubject(subjectId);
    if (subject) {
      if (!subject.documentIds.includes(documentId)) {
        subject.documentIds.push(documentId);
        await this.putSubject(subject);
      }
    }
  }
}
