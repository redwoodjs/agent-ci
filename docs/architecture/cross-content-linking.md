# Architecture: Cross-Source Semantic Linking

## 1. Objective

This document specifies the architecture for a system that automatically identifies and links semantically related content across disparate sources such as Discord, GitHub, and Slack. The primary goal is to create a unified knowledge graph from previously isolated data silos.

## 2. Problem Statement

Organizational knowledge is fragmented across multiple platforms. A technical discussion on a GitHub issue may be related to a user report in a Slack channel and further clarified in a design document. Without an automated way to connect these fragments, retrieving a complete context for any given topic is inefficient and prone to error. This system addresses that problem by creating explicit links between semantically related content items.

## 3. Core Data Models

The system operates on two fundamental data structures: `SemanticTopic` and `CrossSourceLink`.

### 3.1. SemanticTopic

A `SemanticTopic` is an atomic unit of meaning extracted from a piece of source content. It contains normalized text, keywords, and metadata necessary for comparison.

```typescript
interface SemanticTopic {
  id: string; // Unique identifier for the topic
  sourceContentId: string; // ID of the original content item
  sourceType: "github" | "slack" | "discord" | "documentation";
  normalizedText: string; // A canonical representation of the topic's text
  keywords: string[]; // Salient keywords
  context: string; // e.g., "technical_issue", "user_report"
  confidence: number; // The confidence score of the topic extraction
  metadata: Record<string, any>; // Source-specific metadata
}
```

### 3.2. CrossSourceLink

A `CrossSourceLink` represents a directional, typed relationship between two pieces of source content.

```typescript
interface CrossSourceLink {
  id: string; // Unique identifier for the link
  source: {
    contentId: string;
    sourceType: "github" | "slack" | "discord" | "documentation";
  };
  target: {
    contentId: string;
    sourceType: "github" | "slack" | "discord" | "documentation";
  };
  relationship:
    | "references" // Source references target
    | "duplicates" // Source and target describe the same concept
    | "follows_up_on" // Source is a temporal and logical continuation of target
    | "contradicts"; // Source presents information that conflicts with target
  confidence: number; // The confidence score of the relationship classification
  semanticSimilarity: number; // The cosine similarity of the underlying topics
  evidence: string[]; // A list of justifications for the link
}
```

## 4. System Architecture

The system is composed of four main components that execute in a pipeline: the Ingestion and Topic Extraction module, the Similarity Calculation Service, the Relationship Classification Engine, and the Link Persistence Layer.

### 4.1. Ingestion and Topic Extraction

This module is responsible for consuming raw data from each source and converting it into `SemanticTopic` objects. Platform-specific extractors handle the unique structure of each data source.

```typescript
interface IContentExtractor {
  extractTopics(sourceData: any): Promise<SemanticTopic[]>;
}

class GitHubExtractor implements IContentExtractor {
  async extractTopics(issue: GitHubIssue): Promise<SemanticTopic[]> {
    // 1. Ingest GitHub issue data (title, body, comments).
    // 2. Normalize text and extract key phrases.
    // 3. Construct and return an array of SemanticTopic objects.
  }
}

class SlackExtractor implements IContentExtractor {
  async extractTopics(message: SlackMessage): Promise<SemanticTopic[]> {
    // 1. Ingest Slack message data (text, thread context).
    // 2. Normalize text and extract key phrases.
    // 3. Construct and return an array of SemanticTopic objects.
  }
}
```

### 4.2. Similarity Calculation Service

This service computes the semantic similarity between pairs of `SemanticTopic` objects. It uses vector embeddings and a cosine similarity metric, adjusted by contextual weighting factors.

```typescript
class SimilarityCalculator {
  async calculate(
    topicA: SemanticTopic,
    topicB: SemanticTopic
  ): Promise<number> {
    const embeddingA = await this.generateEmbedding(topicA.normalizedText);
    const embeddingB = await this.generateEmbedding(topicB.normalizedText);

    const semanticSimilarity = this.cosineSimilarity(embeddingA, embeddingB);
    const contextWeight = this.getContextWeight(topicA.context, topicB.context);
    const sourceWeight = this.getSourceWeight(
      topicA.sourceType,
      topicB.sourceType
    );

    return semanticSimilarity * contextWeight * sourceWeight;
  }

  private getContextWeight(context1: string, context2: string): number {
    // Returns a weight based on the compatibility of the two contexts.
    // e.g., "technical_issue" and "user_report" have a high compatibility weight.
  }
}
```

### 4.3. Relationship Classification Engine

This engine takes a pair of `SemanticTopic` objects and their similarity score, and classifies the relationship between them (e.g., `duplicates`, `follows_up_on`).

```typescript
class RelationshipClassifier {
  async classify(
    source: SemanticTopic,
    target: SemanticTopic
  ): Promise<RelationshipType> {
    if (await this.isDuplicate(source, target)) {
      return "duplicates";
    }
    if (await this.isFollowUp(source, target)) {
      return "follows_up_on";
    }
    // ... other classification rules
    return "references";
  }

  private async isDuplicate(
    source: SemanticTopic,
    target: SemanticTopic
  ): Promise<boolean> {
    const similarity = await this.calculateSimilarity(source, target);
    const temporalProximity = this.calculateTemporalProximity(source, target);
    return similarity > 0.8 && temporalProximity > 0.7;
  }
}
```

### 4.4. Link Persistence Layer

This component is responsible for storing the generated `CrossSourceLink` objects in a database or graph store. It also manages link directionality, ensuring that links are queryable from either the source or the target.

```typescript
class LinkRepository {
  async storeLink(link: CrossSourceLink): Promise<void> {
    // Store the primary link.
    // ... database logic

    // Create and store the reverse link for bidirectional querying.
    const reverseLink = this.createReverseLink(link);
    // ... database logic
  }

  private createReverseLink(link: CrossSourceLink): CrossSourceLink {
    // ... logic to create the inverse link
  }
}
```

## 5. Implementation Phases

The project will be implemented in four distinct phases.

1.  **Phase 1: Foundational Linking**: Implement topic extraction for all sources and a basic similarity-based linking mechanism.
2.  **Phase 2: Relationship Classification**: Develop and integrate the relationship classification engine to provide typed links.
3.  **Phase 3: Contextual Analysis**: Enhance classification logic with temporal and conversational context awareness.
4.  **Phase 4: Optimization and Scaling**: Focus on performance optimization, caching strategies for embeddings, and monitoring link quality.

## 6. Future Development

Post-MVP, the system can be extended to handle:

- **Multi-Modal Content**: Analyze and link code snippets, images (via OCR), and audio transcripts.
- **Advanced AI Integration**: Use LLMs for more nuanced topic extraction, summarization of linked content, and automated categorization.
- **Real-Time Processing**: Transition from batch processing to a streaming architecture to create links as content is generated.
