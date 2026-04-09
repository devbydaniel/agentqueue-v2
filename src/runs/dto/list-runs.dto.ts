import {
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { runSources, runStatuses } from '../../database/runs.schema.js';

export class ListRunsDto {
  @IsOptional()
  @IsString()
  @IsIn(runStatuses)
  status?: string;

  @IsOptional()
  @IsString()
  @IsIn(runSources)
  source?: string;

  @IsOptional()
  @IsString()
  cwd?: string;

  @IsOptional()
  @IsString()
  trigger?: string;

  @IsOptional()
  @IsISO8601()
  since?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
