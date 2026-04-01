import { IsNotEmpty, IsString } from 'class-validator';

export class ExecuteRunDto {
  @IsString()
  @IsNotEmpty()
  repo!: string;

  @IsString()
  @IsNotEmpty()
  prompt!: string;
}
