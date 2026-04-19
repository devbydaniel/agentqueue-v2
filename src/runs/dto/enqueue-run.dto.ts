import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
} from 'class-validator';

export class EnqueueRunDto {
  @IsString()
  @IsNotEmpty()
  cwd!: string;

  @IsString()
  @IsNotEmpty()
  prompt!: string;

  @IsString()
  @IsOptional()
  appendSystemPrompt?: string;

  @IsInt()
  @IsPositive()
  @IsOptional()
  timeoutMs?: number;

  @IsUUID()
  @IsOptional()
  parentRunId?: string;
}
