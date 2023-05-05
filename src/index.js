addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

function simpleResponse(status, text) {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain;charset=UTF-8",
      'access-control-allow-origin': '*',
    },
  });
}

async function notifyGitHub({ op, owner, repo, reviewId, status, pages }) {
  const payload = {
    event_type: op,
    client_payload: {
      reviewId,
      status,
      pages,
    },
  };

  const pingowner = 'trieloff' || owner; // switch this to dynamic value when the PR has been merged
  const pingrepo = 'thinktanked' || repo;

  // get GH Token from Cloudflare secrets
  const githubToken = await GITHUB_TOKEN;
  // TODO: we may need to go through the bot secrets when this becomes prod ready

  // see https://docs.github.com/en/rest/reference/repos#create-a-repository-dispatch-event
  const url = `https://api.github.com/repos/${pingowner}/${pingrepo}/dispatches`;
  const ghreq = new Request(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github.everest-preview+json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${githubToken}`,
    },
    body: JSON.stringify(payload),
  });
  await fetch(ghreq);
}

async function approveReview(review, env, allReviews) {
  if (!review) {
    return simpleResponse(404, 'Review not found');
  }
  const found = allReviews.findIndex((r) => r.reviewId === review.reviewId);
  if (review.reviewId === 'default') {
    review.pages = '';
    review.status = 'open';
  }
  else allReviews.splice(found, 1);
  await reviews.put(`${env.repo}--${env.owner}`, JSON.stringify(allReviews));
  await notifyGitHub({
    op: 'review-approved',
    reviewId: review.reviewId,
    repo: env.repo,
    owner: env.owner,
    status: review.status,
    pages: review.pages,
  });
  return simpleResponse(200, 'Review Approved');
}

async function rejectReview(review, env, allReviews) {
  if (!review) {
    return simpleResponse(404, 'Review not found');
  }
  review.status = 'open';
  await reviews.put(`${env.repo}--${env.owner}`, JSON.stringify(allReviews));
  return simpleResponse(200, 'Review Rejected');
}

async function submitReview(review, env, allReviews) {
  if (!review) {
    return simpleResponse(404, 'Review not found');
  }
  review.status = 'submitted';
  await reviews.put(`${env.repo}--${env.owner}`, JSON.stringify(allReviews));
  return simpleResponse(200, 'Review Submitted');
}


async function updateReview(review, description, pages, env, allReviews) {
  /* create update review */
  if (!review) {
    review = {};
    review.reviewId = env.reviewId;
    review.status = 'open';
    allReviews.push(review);
  }
  if (description) review.description = description;
  if (review.status === 'submitted') {
    return simpleResponse(403, 'Forbidden. Review is already submitted');
  }

  if (pages) {
    review.pages = pages;
  }
  await reviews.put(`${env.repo}--${env.owner}`, JSON.stringify(allReviews));
  return simpleResponse(200, 'Review Created / Updated');
}

async function addPageToReview(review, page, env, allReviews) {
  if (!review) {
    return simpleResponse(404, 'Review not found');
  }
  if (review.status === 'submitted') {
    return simpleResponse(403, 'Forbidden. Review is already submitted');
  }
  if (!page) {
    return simpleResponse(404, 'Page not found');
  }
  const pages = review.pages ? review.pages.split(',').map((e) => e.trim()) : [];
  pages.push(page);
  review.pages = pages.join(',');
  await reviews.put(`${env.repo}--${env.owner}`, JSON.stringify(allReviews));
  return simpleResponse(200, 'Review Updated');
}

async function removePageFromReview(review, page, env, allReviews) {
  if (!review) {
    return simpleResponse(404, 'Review not found');
  }
  if (review.status === 'submitted') {
    return simpleResponse(403, 'Forbidden. Review is already submitted');
  }
  const pages = review.pages ? review.pages.split(',').map((e) => e.trim()) : [];
  const found = pages.indexOf(page);
  if (found < 0) {
    return simpleResponse(404, 'Page not found');
  }
  pages.splice(found, 1);
  review.pages = pages.join(',');
  await reviews.put(`${env.repo}--${env.owner}`, JSON.stringify(allReviews));
  return simpleResponse(200, 'Review Updated');
}

async function handleRequest(request) {
  const url = new URL(request.url);
  let hostname = url.hostname;

  /* workaround for hostname issues */
  const params = new URLSearchParams(url.search);
  const hostnameOverride = params.get('hostname');
  if (hostnameOverride) hostname = hostnameOverride;

  if (!hostname.endsWith('.hlx.reviews')) 'default--main--thinktanked--davidnuescheler.hlx.reviews';
  const origin = hostname.split('.')[0];
  const splits = origin.split('--');
  if (splits.length === 3) splits.unshift('');
  const [reviewId, ref, repo, owner] = splits;
  const env = { reviewId, ref, repo, owner };

  const value = await reviews.get(`${repo}--${owner}`);

  if (request.method === 'GET') {
    const response = { data: [] };
    if (value) {
      response.data = JSON.parse(value);
    }
    return new Response(JSON.stringify(response), {
      headers: {
        "content-type": "application/json;charset=UTF-8",
        'access-control-allow-origin': '*',
      },
    });
  }

  if (request.method === 'POST') {
    const allReviews = value ? JSON.parse(value) : [];
    console.log(allReviews);
    const [, admin, verb] = url.pathname.split('/');
    let review = allReviews.find((e) => e.reviewId === reviewId);
    const params = new URLSearchParams(url.search);
    const page = params.get('page');
    const description = params.get('description');
    const pages = params.get('pages');

    switch (verb) {
      case 'approve':
        /* approve review */
        return await approveReview(review, env, allReviews);
        break;

      case 'submit':
        /* submit review */
        return await submitReview(review, env, allReviews);
        break;

      case 'reject':
        /* reject review */
        return await rejectReview(review, env, allReviews);
        break;

      case 'add-page':
        /* add page */
        return await addPageToReview(review, page, env, allReviews);
        break;

      case 'remove-page':
        /* add page */
        return await removePageFromReview(review, page, env, allReviews);
        break;

      default:
        /* create update review */
        return await updateReview(review, description, pages, env, allReviews);

    }
  }
}