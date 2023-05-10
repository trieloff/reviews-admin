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

  // get GH Token from Cloudflare secrets
  const githubToken = await GITHUB_TOKEN;
  // TODO: we may need to go through the bot secrets when this becomes prod ready

  // see https://docs.github.com/en/rest/reference/repos#create-a-repository-dispatch-event
  const url = `https://api.github.com/repos/${owner}/${repo}/dispatches`;

  console.log('ready to notify github with', url, payload, githubToken.length);

  const ghreq = new Request(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github.everest-preview+json',
      'User-Agent': 'hlx-reviews on Cloudflare Workers',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${githubToken}`,
    },
    body: JSON.stringify(payload),
  });
  try {
    const res = await fetch(ghreq);
    console.log('github notified', res.status, await res.text());
  } catch (e) {
    console.log('error notifying github', e);
  }

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
  // TODO: use R2 instead of KV
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
  await notifyGitHub({
    op: 'review-rejected',
    reviewId: review.reviewId,
    repo: env.repo,
    owner: env.owner,
    status: review.status,
    pages: review.pages,
  });
  return simpleResponse(200, 'Review Rejected');
}

async function submitReview(review, env, allReviews) {
  if (!review) {
    return simpleResponse(404, 'Review not found');
  }
  review.status = 'submitted';
  await reviews.put(`${env.repo}--${env.owner}`, JSON.stringify(allReviews));
  await notifyGitHub({
    op: 'review-submitted',
    reviewId: review.reviewId,
    repo: env.repo,
    owner: env.owner,
    status: review.status,
    pages: review.pages,
  });
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

  if (pages !== null) {
    review.pages = pages;
  }
  await reviews.put(`${env.repo}--${env.owner}`, JSON.stringify(allReviews));
  await notifyGitHub({
    op: 'review-updated',
    reviewId: review.reviewId,
    repo: env.repo,
    owner: env.owner,
    status: review.status,
    pages: review.pages,
  });
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
  await notifyGitHub({
    op: 'review-updated',
    reviewId: review.reviewId,
    repo: env.repo,
    owner: env.owner,
    status: review.status,
    pages: review.pages,
  });
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
  const pathname = page.split('?')[0];
  const found = pages.findIndex((p) => pathname === p.split('?')[0]);
  if (found < 0) {
    return simpleResponse(404, 'Page not found');
  }
  pages.splice(found, 1);
  review.pages = pages.join(',');
  await reviews.put(`${env.repo}--${env.owner}`, JSON.stringify(allReviews));
  await notifyGitHub({
    op: 'review-updated',
    reviewId: review.reviewId,
    repo: env.repo,
    owner: env.owner,
    status: review.status,
    pages: review.pages,
  });
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