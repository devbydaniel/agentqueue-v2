import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ExecuteRunDto } from './dto/execute-run.dto.js';
import { ExecuteRunUseCase } from '../application/execute-run.use-case.js';

@ApiTags('Runs')
@Controller('runs')
export class RunsController {
  constructor(private readonly executeRunUseCase: ExecuteRunUseCase) {}

  @Post()
  @ApiOperation({
    summary: 'Execute a synchronous agent run',
    description:
      'Resolves the repo via agentfiles config, creates a pi agent session, runs the prompt to completion, and returns a success flag.',
  })
  @ApiResponse({ status: 201, description: 'Run completed successfully' })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  @ApiResponse({
    status: 404,
    description: 'Repo not found in agentfiles config',
  })
  @ApiResponse({ status: 500, description: 'Unexpected error during run' })
  async executeRun(@Body() dto: ExecuteRunDto) {
    return this.executeRunUseCase.execute(dto);
  }
}
