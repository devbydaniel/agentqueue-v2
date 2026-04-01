import { ApplicationErrorFilter } from './application-error.filter.js';
import { ApplicationError } from '../errors/base.error.js';

class TestError extends ApplicationError {
  constructor() {
    super('Something went wrong', 'TEST_ERROR', 422);
  }
}

describe('ApplicationErrorFilter', () => {
  let filter: ApplicationErrorFilter;

  beforeEach(() => {
    filter = new ApplicationErrorFilter();
  });

  it('should return the correct status code and body for an ApplicationError', () => {
    const error = new TestError();
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const response = { status };

    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
      }),
    } as any;

    filter.catch(error, host);

    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({
      statusCode: 422,
      code: 'TEST_ERROR',
      message: 'Something went wrong',
    });
  });
});
