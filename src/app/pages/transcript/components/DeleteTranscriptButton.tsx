"use client";

import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { deleteTranscriptFromR2 } from "../actions";

interface DeleteTranscriptButtonProps {
  containerId: string;
  transcriptId: string;
  transcriptTitle: string;
  onDeleted?: () => void;
}

export function DeleteTranscriptButton({
  containerId,
  transcriptId,
  transcriptTitle,
  onDeleted,
}: DeleteTranscriptButtonProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);

    try {
      const result = await deleteTranscriptFromR2(containerId, transcriptId);

      if (result.success) {
        // Refresh the page to remove the deleted transcript
        window.location.reload();
      } else {
        console.error("Failed to delete transcript:", result.error);
        alert(`Failed to delete transcript: ${result.error}`);
      }
    } catch (error) {
      console.error("Error deleting transcript:", error);
      alert("Error deleting transcript. Please try again.");
    } finally {
      setIsDeleting(false);
      setShowConfirm(false);
    }
  };

  const handleConfirmClick = () => {
    if (
      window.confirm(
        `Are you sure you want to delete "${transcriptTitle}"? This action cannot be undone.`
      )
    ) {
      handleDelete();
    }
  };

  if (showConfirm) {
    return (
      <div className="flex gap-2 mt-2">
        <Button
          onClick={handleConfirmClick}
          disabled={isDeleting}
          variant="destructive"
          size="sm"
        >
          {isDeleting ? "Deleting..." : "Confirm Delete"}
        </Button>
        <Button
          onClick={() => setShowConfirm(false)}
          disabled={isDeleting}
          variant="outline"
          size="sm"
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <Button
      onClick={() => setShowConfirm(true)}
      disabled={isDeleting}
      variant="outline"
      size="sm"
      className="mt-2 text-red-600 hover:text-red-700 hover:bg-red-50"
    >
      Delete from Context Stream
    </Button>
  );
}

