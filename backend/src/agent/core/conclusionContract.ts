// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type ConclusionOutputMode = 'initial_report' | 'focused_answer' | 'need_input';
export type ConclusionClusterOutputMode = 'required' | 'optional' | 'none';
export type ConclusionClusterFrameListMode = 'none' | 'top' | 'full';

export interface ConclusionContractConclusionItem {
  rank: number;
  statement: string;
  confidencePercent?: number;
  trigger?: string;
  supply?: string;
  amplification?: string;
}

export interface ConclusionContractClusterItem {
  cluster: string;
  description?: string;
  frames?: number;
  percentage?: number;
  frameRefs?: string[];
  omittedFrameRefs?: number;
}

export interface ConclusionContractClusterPolicy {
  outputMode: ConclusionClusterOutputMode;
  frameListMode: ConclusionClusterFrameListMode;
  maxFramesPerCluster?: number;
}

export interface ConclusionContractEvidenceItem {
  conclusionId: string;
  text: string;
}

export interface ConclusionContractClaimReference {
  evidenceRefId: string;
  rowIndex?: number;
  rowSelector?: Record<string, string | number | boolean>;
  column?: string;
  value?: string | number | boolean;
  sourceRef?: string;
  sourceToolCallId?: string;
}

export interface ConclusionContractClaimItem {
  id?: string;
  conclusionId?: string;
  text: string;
  references: ConclusionContractClaimReference[];
}

export interface ConclusionContractMetadata {
  confidencePercent?: number;
  rounds?: number;
  clusterPolicy?: ConclusionContractClusterPolicy;
  sceneId?: string;
}

export interface ConclusionContract {
  schemaVersion: 'conclusion_contract_v1';
  mode: ConclusionOutputMode;
  conclusions: ConclusionContractConclusionItem[];
  clusters: ConclusionContractClusterItem[];
  evidenceChain: ConclusionContractEvidenceItem[];
  claims?: ConclusionContractClaimItem[];
  uncertainties: string[];
  nextSteps: string[];
  metadata?: ConclusionContractMetadata;
}
