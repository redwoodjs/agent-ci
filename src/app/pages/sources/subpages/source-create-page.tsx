"use client";

import { useState } from "react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import { createSource } from "./create-source-action";

export function SourceCreatePage() {
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);

    const formData = new FormData(event.currentTarget);

    try {
      const result = await createSource(formData);
      if (result.success) {
        window.location.href = `/sources/${result.sourceId}`;
      } else {
        alert(result.error || "Failed to create source");
      }
    } catch (error) {
      alert("An error occurred while creating the source");
      console.error(error);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="mb-6">
        <p className="text-muted-foreground">
          Add a new data source to the system
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Source Details</CardTitle>
          <CardDescription>
            Enter the details for the new source
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <label htmlFor="name" className="text-sm font-medium text-black">
                Name
              </label>
              <Input
                id="name"
                name="name"
                required
                placeholder="My Source"
                disabled={isSubmitting}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="type" className="text-sm font-medium text-black">
                Type
              </label>
              <Input
                id="type"
                name="type"
                required
                placeholder="discord, github, etc."
                disabled={isSubmitting}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="url" className="text-sm font-medium text-black">
                URL (optional)
              </label>
              <Input
                id="url"
                name="url"
                type="text"
                placeholder="https://example.com"
                disabled={isSubmitting}
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="description"
                className="text-sm font-medium text-black"
              >
                Description
              </label>
              <textarea
                id="description"
                name="description"
                required
                className="w-full min-h-[100px] px-3 py-2 border border-input rounded-md text-sm"
                placeholder="Enter a description or JSON configuration"
                disabled={isSubmitting}
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="bucket"
                className="text-sm font-medium text-black"
              >
                Bucket
              </label>
              <Input
                id="bucket"
                name="bucket"
                placeholder="default"
                defaultValue="default"
                disabled={isSubmitting}
              />
            </div>

            <div className="flex gap-3 pt-4">
              <Button
                type="submit"
                className="bg-green-600 hover:bg-green-700"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Creating..." : "Create Source"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => (window.location.href = "/sources")}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
